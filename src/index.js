const sqlite3 = require('better-sqlite3', {verbose: console.log});
const express = require('express');
const bodyParser = require('body-parser');
const mergeFiles = require('merge-files');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const server = express();
const PORT = process.env.PORT || 8080;

const CACHE_PATH = '/usr/src/app/.caches';
const PART_PREFIX = '/tmp/.cache_';
const PART_EXT = '.part';
const PART_META_EXT = '.meta';

// DB Setup
const db = new sqlite3('/usr/local/etc/cache.db');
try {
    db.prepare("" +
        "CREATE TABLE caches (" +
        "id INTEGER PRIMARY KEY, " +
        "key TEXT NOT NULL, " +
        "version TEXT NOT NULL, " +
        "started INTEGER DEFAULT (0) NOT NULL, " +
        "complete INTEGER DEFAULT (0) NOT NULL)"
    ).run();
    db.prepare("CREATE INDEX idx_key ON caches (key)");
    db.prepare("CREATE UNIQUE INDEX idx_key ON caches (key, version)");
} catch {
}

const unless = (re_paths, middleware) => {
    return function(req, res, next) {
        for(let re of re_paths) {
            if(re.test(req.path)) {
                return next();
            }
        }
        return middleware(req, res, next);
    };
};

const authmiddleware = (req, res, next) => {
    if (req.get('Authorization') !== `Bearer ${process.env.AUTH_KEY}`) {
        res.status(401).json({message: 'You are not authorized'});
    } else {
        next();
    }
};

const purge = (onlyUncompleted=true) => {
    var selectQ, deleteQ;
    if (onlyUncompleted === true) {
        selectQ = "SELECT * from caches WHERE complete = 0";
        deleteQ = "DELETE FROM caches WHERE complete = 0";
    } else {
        selectQ = "SELECT * from caches";
        deleteQ = "DELETE FROM caches";
    }
    const rows = db.prepare(selectQ).all();
    for (const row of rows) {
        // Remove temporary uploads
        const tmpPartPaths = `${PART_PREFIX}${row.id}`;
        console.log(`Removing ${tmpPartPaths}`);
        fs.rmSync(tmpPartPaths, {recursive: true, force: true});
        // Remove cached artifacts if any
        const cacheFile = path.join(CACHE_PATH, row.id.toString());
        console.log(`Removing ${cacheFile}`);
        fs.rmSync(cacheFile, {recurse: true, force: true});
    }
    console.log('Purging DB');
    db.prepare(deleteQ).run();
};

console.log("Cleaning up uncompleted transfers");
// Clean uncompleted transfers from disk and DB
purge(true);
console.log("Done");

server.set('query parser', 'simple')
server.use(bodyParser.json());
server.use(bodyParser.raw({
    type: 'application/octet-stream',
    limit: '500mb'
}))

server.use(unless([
    /^\/_apis\/artifactcache\/artifacts\/\d+$/], authmiddleware));

server.get('/', (req, res) => {
    res.status(200).send({
        status: 'success'
    })
})

function getMatchingPrimaryKey(primaryKey, version, restorePaths=[], exactMatch = true) {
    let row;
    if(exactMatch)
    {
        row = db.prepare("SELECT * FROM caches WHERE key = ? AND version = ?").get(primaryKey, version);
    }
    else
    {
        row = db.prepare(`SELECT * FROM caches WHERE key LIKE '${primaryKey}%' AND version = '${version}' ORDER BY id DESC`).get();
    }
    if(row !== undefined)
    {
        return {id: row.id, key: primaryKey};
    } else if (restorePaths.length > 0) {
        const newPrimaryKey = restorePaths[0];
        const newRestorePaths = restorePaths.slice(1);
        return getMatchingPrimaryKey(newPrimaryKey, version, newRestorePaths, false);
    } else {
        return undefined;
    }
}

// Check if matching cache file exists
//
// -- input --
// keys: list of strings consisting of a primaryKey string and optional restorePath strings prefixes(comma-separated)
// version: hashed string of the paths the cache contains and the compression cache method
//
// -- output --
// archiveLocation: URL of the archived cache for downloading
// cacheKey: exact cache key string used, this usually will be primaryKey but if it's not matched and restorePath
// prefix strings are provided, it could be the full primaryKey for one of the restorePaths
//
// -- logic --
//  1 - look for an exact match on `primaryKey`
//      1.1 - HIT
//          1.1.1 - compare if `version` matches in the DB entry
//              1.1.1.1 - HIT
//                  1.1.1.1.1 - return a CACHE HIT 200 code. archivePath: as file cache download URL, cacheKey: as current `primaryKey`
//              1.1.1.2 - MISS
//                  1.1.1.2.1 - go to `1.2`
//      1.2 - MISS
//          1.2.1 - If there are `restorePaths` prefixes remaining
//              1.2.1.1 - pick the next `restorePath` prefix
//                  1.2.1.1.1 - look for a primary key in the DB that matches the prefix
//                      1.2.1.1.1.1 - HIT
//                          1.2.1.1.1.1.1 - set matched primary key as `primaryKey` and got to `1`
//                      1.2.1.1.1.2 - MISS
//                          1.2.1.1.1.2.1 - go to `1.2`
//          1.2.2 - If there aren't `restorePaths` prefixes remaining
//              1.2.2.1 - return a CACHE MISS 204 code
//
server.get('/_apis/artifactcache/cache', (req, res) => {
    const keyList = req.query.keys.split(',');
    const primaryKey = keyList[0]
    const restorePaths = keyList.slice(1);
    const version = req.query.version;

    const idAndKey = getMatchingPrimaryKey(primaryKey, version, restorePaths);
    if(idAndKey === undefined)
    {
        console.log(`Missing key ${primaryKey}`);
        res.status(204).json({});
    }
    else
    {
        const cacheId = idAndKey.id;
        const foundPrimaryKey = idAndKey.key;
        console.log(`Found key ${foundPrimaryKey} with id ${cacheId}`);

        const cacheFile = path.join(CACHE_PATH, `${cacheId}`);
        if(!fs.existsSync(cacheFile))
        {
            console.log(`Missing cache file ${cacheFile}`);
            res.status(204).json({});
        }
        else
        {
            const baseURL = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
            const cacheFileURL = `${baseURL}/_apis/artifactcache/artifacts/${cacheId}`;
            res.status(200).json({result: 'hit', archiveLocation: cacheFileURL, cacheKey: foundPrimaryKey});
        }
    }
});

// Reserve a cache for an upcoming upload
server.post('/_apis/artifactcache/caches', (req, res) => {
    const key = req.body.key
    const version = req.body.version

    console.log(`Request to reserve cache ${key} for uploading`);
    const row = db.prepare("SELECT * FROM caches WHERE key = ? AND version = ?").get(key, version);
    if(row !== undefined) {
        if (Boolean(row.complete)) {
            const err = `Cache id ${row.id} was already uploaded`;
            console.error(err);
            res.status(400).json({error: err});
        } else if (Boolean(row.started)) {
            const err = `Cache id ${row.id} is already reserved and uploading`;
            console.error(err);
            res.status(400).json({error: err});
        } else {
            console.log(`Cache id ${row.id} already reserved, but did not start uploading`);
            res.status(200).json({cacheId: row.id});
        }
    }
    else
    {
        const id = db.prepare("INSERT INTO caches (key, version) VALUES (?, ?)").run(key, version).lastInsertRowid;
        res.status(200).json({cacheId: id});
    }
});

function writePartFile (id, body, contentRange) {
    const file = getPartFile(id, contentRange);
    // .meta file contains the contentRange value and will be used to order and merge .part files
    const metaFile = file + PART_META_EXT;
    console.log(`Writing range ${contentRange} to ${metaFile}`);
    fs.writeFileSync(`${path.normalize(metaFile)}`, contentRange, {encoding: 'utf-8'});
    console.log(`Write file part to ${file}`);
    fs.writeFileSync(`${path.normalize(file)}`, body);
}

function getPartFile (cacheId, contentRange) {
    const tmpPartPaths = `${PART_PREFIX}${cacheId}`;
    !fs.existsSync(tmpPartPaths) && fs.mkdirSync(tmpPartPaths, { recursive: true });
    const fileName = crypto.createHash('sha256').update(contentRange).digest('hex');
    return path.join(tmpPartPaths, `${fileName}${PART_EXT}`);
}

function getOrderedPartFiles (cacheId) {
    const tmpPartPaths = `${PART_PREFIX}${cacheId}`;
    if (!fs.existsSync(tmpPartPaths)) {
        return null;
    } else {
        let res = [];
        const metaPartFiles = fs.readdirSync(tmpPartPaths).filter((file) => {
            return file.indexOf(PART_META_EXT) !== -1;
        });
        let rangeMap = {};
        for (const metaPartFile of metaPartFiles) {
            const metaPartFilePath = path.join(tmpPartPaths, metaPartFile);
            const content = fs.readFileSync(metaPartFilePath, {encoding: 'utf-8'});
            // Range string is of the form "bytes 67108864-100663295/*"
            const startRange = Number(content.split('-')[0].split(' ')[1].trim());
            rangeMap[startRange] = path.join(tmpPartPaths, path.parse(metaPartFilePath).name);
        }
        Object.keys(rangeMap).sort((a, b) => Number(a) - Number(b)).map((k) => { res.push(rangeMap[k]); });
        for (let i = 0; i < res.length; i++) {
            const partFilePath = res[i];
            console.log(`Part ${i + 1}/${res.length} is file ${partFilePath}`);
            if (!fs.existsSync(partFilePath)) {
                console.error(`File ${partFilePath} does not exist`);
                return null;
            }
        }
        return res;
    }
}

// Upload cache file parts with a cache id
server.patch('/_apis/artifactcache/caches/:cacheId', (req, res) => {
    console.log('Upload request');
    const {cacheId} = req.params;

    const row = db.prepare("SELECT * FROM caches WHERE id = ?").get(cacheId);
    if (row === undefined) {
        const err = `Cache with id ${cacheId} has not been reserved`;
        console.error(err);
        res.status(400).json({error: err});
    }
    else if (Boolean(row.complete)){
        const err = `Upload cache with ${row.id} has already been committed and completed`;
        console.error(err);
        res.status(400).json({error: err});
    } else {
        if (!Boolean(row.started)){
            console.log(`Upload for cache id ${row.id} started`)
            db.prepare("UPDATE caches SET started = 1 WHERE id = ?").run(row.id);
        }
        const contentRange = req.header('Content-Range');
        writePartFile(row.id, req.body, contentRange);
        res.status(200).json({});
    }
});

// Commit the cache parts upload
server.post('/_apis/artifactcache/caches/:cacheId', (req, res) => {
    console.log('Commit cache request');
    const {cacheId} = req.params;

    const row = db.prepare("SELECT * FROM caches WHERE id = ?").get(cacheId);
    if (row === undefined) {
        const err = `Cache with id ${cacheId} has not been reserved`;
        console.error(err);
        res.status(400).json({error: err});
    }
    else if (Boolean(row.complete)){
        const err = `Upload cache with ${row.id} has already been committed and completed`;
        console.error(err);
        res.status(400).json({error: err});
    }
    else if (!Boolean(row.started)){
        const err = `Upload for cache id ${row.id} has been reserved but never started uploading`;
        console.error(err);
        res.status(400).json({error: err});
    } else {
        const {size} = req.body;
        const partFiles = getOrderedPartFiles(cacheId);
        if (partFiles === null || partFiles.length === 0) {
            const err = `No uploaded parts to commit for id ${cacheId}`;
            console.error(err)
            res.status(400).json({error: err});
        } else {
            const cacheFile = path.join(CACHE_PATH, `${cacheId}`);
            mergeFiles(partFiles, cacheFile).then((status) => {
                const cacheFileSize = fs.statSync(cacheFile).size;
                if (cacheFileSize !== size) {
                    const err = `Uploaded size mismatch: received ${cacheFileSize} expected ${size}`;
                    console.error(err)
                    res.status(400).json({error: err});
                } else {
                    res.status(200).json({});
                    db.prepare("UPDATE caches SET complete = 1 WHERE id = ?").run(row.id);
                }
                const tmpPartPaths = `${PART_PREFIX}${cacheId}`;
                fs.rmSync(tmpPartPaths, {recursive: true, force: true});
            });
        }
    }
});

// Download artifact with a given id from the cache
server.get('/_apis/artifactcache/artifacts/:cacheId', (req, res) => {
    const {cacheId} = req.params;
    const cacheFile = path.join(CACHE_PATH,`${cacheId}`);
    const {size} = fs.statSync(cacheFile);
    res.header('Content-Length', size);
    console.log(`File size: ${size}`);

    fs.createReadStream(cacheFile).pipe(res);
});

// Purge cache storage and DB
server.post('/_apis/artifactcache/clean', (req, res) => {
    purge(false);
    res.status(200).json({});
});

const appServer = server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
})

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server')
  appServer.close(() => {
    db.close();
      console.log('HTTP server closed')
  })
})
