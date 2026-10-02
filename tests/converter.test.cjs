const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(fetch) {
    const tip = { textContent: '' };
    const result = { src: 'blob:first' };
    const download = { download: 'y2k-cam.webm', href: 'blob:first', style: {}, setAttribute() {}, addEventListener() {} };
    const share = {};
    const modal = { open: true, querySelector: () => tip };
    const nodes = { videoModal: modal, videoResult: result, downloadVideoBtn: download, shareVideoBtn: share };
    let originalShares = 0;
    const sandbox = { document: { getElementById: id => nodes[id] },
        fetch, Blob, File, URL, queueMicrotask, navigator: {}, console: { error() {}, warn() {} },
        MutationObserver: class { observe() {} disconnect() {} },
        shareCurrentVideo: async () => { originalShares++; }, addEventListener() {} };
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../mp4-converter.js'), 'utf8'), ctx);
    return { result, download, share, tip, originalShares: () => originalShares,
        run: code => vm.runInContext(code, ctx) };
}
test('a stale conversion cannot overwrite a newer recording and the latest is processed', async () => {
    let resolveFirst;
    const app = setup(url => url === 'blob:first'
        ? new Promise(resolve => { resolveFirst = resolve; })
        : Promise.resolve({ blob: async () => new Blob(['new'], { type: 'video/mp4' }) }));
    const pending = app.run('processLatestRecording()');
    app.result.src = 'blob:second'; app.download.href = 'blob:second'; app.download.download = 'y2k-cam.mp4';
    app.run('processLatestRecording()');
    resolveFirst({ blob: async () => new Blob(['old'], { type: 'video/mp4' }) });
    await pending; await settle();
    assert.equal(await app.run('convertedVideoBlob.text()'), 'new');
    assert.equal(app.download.href, app.result.src);
    assert.equal(app.share.disabled, false);
});
test('failed conversion retains original format and delegates sharing to the original recording', async () => {
    const app = setup(async () => ({ blob: async () => new Blob(['webm'], { type: 'video/webm' }) }));
    app.run("transcodeToMp4 = async () => { throw new Error('Conversion unavailable'); }");
    await app.run('processLatestRecording()');
    assert.equal(app.download.href, 'blob:first');
    assert.equal(app.download.download, 'y2k-cam.webm');
    assert.equal(app.share.disabled, false);
    await app.run('shareConvertedVideo()');
    assert.equal(app.originalShares(), 1);
});
