const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const {totalist} = require('totalist/sync');
const server = express();
const PORT = process.env.PORT || 8080;
const IS_WINDOWS = process.platform === 'win32';

server.use(bodyParser.json());

server.get('/', (req, res) => {
    res.status(200).send({
        status: 'success'
    })
})

server.post('/_apis/pipelines/workflows/:runId/artifacts', (req, res) => {
    const {runId} = req.params;
    const baseURL = `${req.protocol}://${req.get('host')}${req.baseUrl}`;

    res.json({fileContainerResourceUrl: `${baseURL}/upload/${runId}`});
});

server.patch('/_apis/pipelines/workflows/:runId/artifacts', (req, res) => {
    const {runId} = req.params;

    res.status(200).json({message: 'success'});
});

server.get('/_apis/pipelines/workflows/:runId/artifacts', (req, res) => {
    const {runId} = req.params;
    const artifacts = new Set();
   const baseURL = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
    totalist(`./${runId}`, (name, abs, stats) => {
        name = name.replace('\\', '/');
        const fileDetails = {
            name: name.split('/')[0],
            fileContainerResourceUrl: `${baseURL}/download/${runId}`
        }
        artifacts.add(fileDetails);
    });
    console.log(artifacts);
    res.status(200).json({count: artifacts.count, value: [...artifacts]});
});

server.get('/download/:container', (req, res) => {
    const {container} = req.params;
    const baseURL = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
    const files = new Set();
    totalist(container, (name, abs, stats) => {
        console.log(name);
        console.log(abs);
        files.add({
            path: path.normalize(name),
            itemType: 'file',
            contentLocation: `${baseURL}/download/${container}/${name.replace('\\', '/')}`
        });
    })
    res.status(200).json({value: [...files]})
});

server.get('/download/:container/:path(*)', (req, res) => {
    const path = `${req.params.container}/${req.params.path}`;
    fs.createReadStream(path, {encoding: 'base64'}).pipe(res);
});

server.use(bodyParser.raw({
    type: 'application/octet-stream',
    limit: '50mb'
}))
server.put('/upload/:runId', (req, res, next) => {
    const { itemPath } = req.query;
    const {runId} = req.params;
    req.setEncoding('base64');
    fs.ensureFileSync(`${runId}/${itemPath}`);
    fs.writeFile(`${runId}/${path.normalize(itemPath)}`, req.body, {encoding: 'utf-8'}, (err) => {
        if (err) {
            console.error(err);
        }
        res.status(200).json({message: 'success'})
    });
});

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
})