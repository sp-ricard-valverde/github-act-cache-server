const sqlite3 = require('better-sqlite3', {verbose: console.log});
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const server = express();
const PORT = process.env.PORT || 8080;

// DB Setup
const db = new sqlite3('/usr/local/etc/cache.db');
try {
    db.prepare("CREATE TABLE caches (id INTEGER PRIMARY KEY, key TEXT NOT NULL, version TEXT NOT NULL)").run();
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
    console.log(process.env.AUTH_KEY);
    console.log(req.get('Authorization'));
    if (req.get('Authorization') !== `Bearer ${process.env.AUTH_KEY}`) {
        res.status(401).json({message: 'You are not authorized'});
    } else {
        next();
    }
};

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
    if(exactMatch === false)
    {
        row = db.prepare("SELECT * FROM caches WHERE key = ? AND version = ?").get(primaryKey, version);
    }
    else
    {
        row = db.prepare(`SELECT * FROM caches WHERE key LIKE '${primaryKey}%' AND version = '${version}'`).get();
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

        const cacheFile = `./.caches/${cacheId}`;
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

// Reserve a cache id or get existing
server.post('/_apis/artifactcache/caches', (req, res) => {
    const key = req.body.key
    const version = req.body.version

    console.log(`Request to reserve key ${key}`);
    var id;
    const row = db.prepare("SELECT * FROM caches WHERE key = ? AND version = ?").get(key, version);
    if(row === undefined)
    {
        id = db.prepare("INSERT INTO caches (key, version) VALUES (?, ?)").run(key, version).lastInsertRowid;
    }
    else
    {
        id = row.id;
    }
    console.log(`Returning id ${id}`);
    res.status(200).json({cacheId: id})
});

// ?
server.post('/_apis/artifactcache/caches/:cacheId', (req, res) => {
    const {cacheId} = req.params;
    res.status(200).json({})
});

// Upload cache file with a reserved cache id
server.patch('/_apis/artifactcache/caches/:cacheId', (req, res) => {
    const {cacheId} = req.params;
    const cacheFile = `./.caches/${cacheId}`;

    fs.writeFile(`${path.normalize(cacheFile)}`, req.body, {encoding: 'utf-8'}, (err) => {
        if (err) {
            console.error(err);
        }
        res.status(200).json({message: 'success'})
    });
});

// Download artifact with a given id from the cache
server.get('/_apis/artifactcache/artifacts/:cacheId', (req, res) => {
    const {cacheId} = req.params;
    const cacheFile = `./.caches/${cacheId}`;
    const {size} = fs.statSync(cacheFile);
    res.header('Content-Length', size);
    console.log(`File size: ${size}`);

    fs.createReadStream(cacheFile).pipe(res);
});

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
})

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server')
  server.close(() => {
    db.close();
      console.log('HTTP server closed')
  })
})
