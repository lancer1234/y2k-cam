const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup({ cameraError, recorderError, portrait = false } = {}) {
    const elements = new Map();
    const tracks = [];
    const drawCalls = [];
    const timers = new Map();
    const callbacks = new Map();
    let nextId = 0;
    let cameraConstraints;
    const context2d = () => new Proxy({
        drawImage: (...args) => drawCalls.push(args),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        createRadialGradient: () => ({ addColorStop() {} })
    }, { get: (obj, key) => obj[key] || (() => {}) });
    const stream = () => {
        const track = { stopped: false, stop() { this.stopped = true; } };
        tracks.push(track);
        return { getTracks: () => [track] };
    };
    function element(id) {
        const classes = new Set();
        const attrs = new Map();
        const ctx = context2d();
        const listeners = new Map();
        return {
            id, style: { setProperty() {} }, dataset: {}, width: 300, height: 150, textContent: '',
            videoWidth: portrait ? 720 : 1280, videoHeight: portrait ? 1280 : 720, paused: false, ended: false, open: false,
            getContext: () => ctx, captureStream: stream,
            toBlob: fn => fn(new Blob(['photo'], { type: 'image/png' })),
            play: async () => {}, pause() { this.paused = true; },
            classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, v) => v ? classes.add(x) : classes.delete(x) },
            setAttribute: (x, v) => attrs.set(x, v), getAttribute: x => attrs.get(x),
            addEventListener: (name, fn) => listeners.set(name, fn),
            showModal() { this.open = true; }, close() { this.open = false; listeners.get('close')?.(); },
            click() {},
        };
    }
    function get(id) {
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
    }
    class Recorder {
        static isTypeSupported() { return true; }
        constructor(s, options) {
            if (recorderError) throw new Error('Recorder failed');
            this.mimeType = options?.mimeType || 'video/webm'; this.state = 'inactive';
        }
        start() { this.state = 'recording'; }
        stop() {
            this.state = 'inactive';
            this.ondataavailable({ data: new Blob(['frames']) });
            queueMicrotask(() => this.onstop());
        }
    }
    const events = new Map();
    const doc = { hidden: false, getElementById: get, createElement: element,
        querySelectorAll: () => [get('photoModal'), get('videoModal')],
        addEventListener: (name, fn) => events.set(name, fn) };
    const sandbox = { document: doc, navigator: { mediaDevices: { getUserMedia: async constraints => {
        cameraConstraints = constraints;
        if (cameraError) throw Object.assign(new Error('Camera failed'), { name: cameraError });
        return stream();
    } } }, console: { warn() {}, error() {} }, Blob, File, URL,
        MediaRecorder: Recorder, queueMicrotask, performance,
        requestAnimationFrame: fn => { const id = ++nextId; callbacks.set(id, fn); return id; },
        cancelAnimationFrame: id => callbacks.delete(id),
        setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
        clearTimeout: id => timers.delete(id),
        addEventListener: (name, fn) => events.set(name, fn), isSecureContext: true, matchMedia: () => ({ matches: portrait }) };
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), ctx);
    return { drawCalls, cameraConstraints: () => cameraConstraints, ctx, get, tracks, timers, events, doc, run: code => vm.runInContext(code, ctx) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('camera failure exposes retry and prevents empty captures', async () => {
    const app = setup({ cameraError: 'NotAllowedError' }); await settle();
    assert.match(app.get('cameraMessage').textContent, /權限/);
    assert.equal(app.get('retryCameraBtn').hidden, false);
    assert.equal(app.get('snapshotBtn').disabled, true);
    await app.run('takeSnapshot()');
    assert.equal(app.get('photoModal').open, false);
});
test('controls wait for the first rendered frame and expose selected state', async () => {
    const app = setup(); await settle();
    assert.equal(app.get('snapshotBtn').disabled, true);
    app.run('processFrame(100)');
    assert.equal(app.get('snapshotBtn').disabled, false);
    app.run("setMode('pixel')");
    assert.equal(app.get('btnPixel').getAttribute('aria-pressed'), 'true');
    assert.equal(app.get('snapshotBtn').disabled, true);
    app.run('processFrame(150)');
    assert.equal(app.get('snapshotBtn').disabled, false);
});
test('recording locks the captured canvas until stop event and releases tracks', async () => {
    const app = setup(); await settle(); app.run('processFrame(100)');
    await app.run('startRecording()');
    assert.equal(app.get('switchCameraBtn').disabled, true);
    app.run("setMode('pixel')");
    assert.equal(app.run('currentMode'), 'ascii');
    assert.equal(app.get('recordBtn').disabled, false);
    app.run('stopRecording()');
    assert.equal(app.get('btnPixel').disabled, true);
    await settle();
    assert.equal(app.get('btnPixel').disabled, false);
    assert.equal(app.tracks.at(-1).stopped, true);
    assert.equal(app.get('videoModal').open, true);
});
test('failed recorder initialization releases the canvas stream', async () => {
    const app = setup({ recorderError: true }); await settle(); app.run('processFrame(100)');
    await app.run('startRecording()');
    assert.equal(app.tracks.at(-1).stopped, true);
    assert.match(app.get('captureHint').textContent, /無法開始/);
    assert.equal(app.run('recordingBusy'), false);
});
test('backgrounding ends recording instead of silently producing frozen frames', async () => {
    const app = setup(); await settle(); app.run('processFrame(100)'); await app.run('startRecording()');
    app.doc.hidden = true; app.events.get('visibilitychange')(); await settle();
    assert.equal(app.run('recordingBusy'), false);
    assert.equal(app.tracks.at(-1).stopped, true);
});
test('photo preview uses native dialog and closes', async () => {
    const app = setup(); await settle(); app.run('processFrame(100)'); await app.run('takeSnapshot()');
    assert.equal(app.get('photoModal').open, true);
    app.run('closeModal()'); assert.equal(app.get('photoModal').open, false);
});
test('recording stops automatically after fifteen seconds', async () => {
    const app = setup(); await settle(); app.run('processFrame(100)'); await app.run('startRecording()');
    [...app.timers.values()].find(timer => timer.ms === 15000).fn(); await settle();
    assert.equal(app.run('recordingBusy'), false);
    assert.equal(app.get('videoModal').open, true);
});

test('portrait phone preserves portrait output without forcing camera dimensions', async () => {
    const app = setup({ portrait: true }); await settle();
    assert.equal(app.cameraConstraints().video.width, undefined);
    assert.equal(app.cameraConstraints().video.height, undefined);
    assert.equal(app.cameraConstraints().video.resizeMode, 'none');
    assert.equal(app.cameraConstraints().video.aspectRatio, undefined);
    app.run('processFrame(100)');
    assert.ok(app.get('asciiCanvas').height > app.get('asciiCanvas').width);
    assert.ok(Math.abs(app.get('asciiCanvas').width / app.get('asciiCanvas').height - 9 / 16) < 0.02);
    app.run("setMode('pixel')"); app.run('processFrame(150)');
    assert.ok(app.get('pixelCanvas').height > app.get('pixelCanvas').width);
    await app.run('startRecording()');
    assert.equal(app.run('currentMode'), 'pixel');
    assert.equal(app.run('recordingBusy'), true);
});

test('portrait output stays vertical even when the device supplies a landscape stream', async () => {
    const app = setup({ portrait: true }); await settle();
    app.get('webcam').videoWidth = 1280; app.get('webcam').videoHeight = 720;
    app.run('processFrame(100)');
    assert.ok(app.get('asciiCanvas').height > app.get('asciiCanvas').width);
    app.run("setMode('pixel')"); app.run('processFrame(150)');
    assert.ok(Math.abs(app.get('pixelCanvas').width / app.get('pixelCanvas').height - 9 / 16) < 0.01);
});

test('landscape source is fitted in portrait output without source cropping', async () => {
    const app = setup({ portrait: true }); await settle();
    app.get('webcam').videoWidth = 1280; app.get('webcam').videoHeight = 720;
    app.run('processFrame(100)');
    const call = app.drawCalls.find(args => args[0].id === 'webcam');
    assert.equal(call.length, 5);
    assert.equal(call[1], 0);
    assert.ok(call[2] > 0);
    assert.equal(call[3], app.run('frameCols'));
    assert.ok(call[4] < app.run('frameRows'));
});
test('portrait source retains its native 3:4 aspect instead of forcing 9:16', async () => {
    const app = setup({ portrait: true });
    app.get('webcam').videoWidth = 960; app.get('webcam').videoHeight = 1280;
    await settle();
    assert.equal(app.run('captureAspect'), 3 / 4);
    app.run("setMode('pixel')"); app.run('processFrame(100)');
    assert.ok(Math.abs(app.get('pixelCanvas').width / app.get('pixelCanvas').height - 3 / 4) < 0.01);
});

test('photo and video mode select a single shutter and cannot switch during recording', async () => {
    const app = setup({ portrait: true }); await settle(); app.run('processFrame(100)');
    app.run("setCaptureKind('video')");
    assert.equal(app.get('snapshotBtn').hidden, true);
    assert.equal(app.get('recordBtn').hidden, false);
    assert.equal(app.get('captureVideoBtn').getAttribute('aria-pressed'), 'true');
    await app.run('startRecording()');
    app.run("setCaptureKind('photo')");
    assert.equal(app.run('captureKind'), 'video');
    assert.equal(app.get('capturePhotoBtn').disabled, true);
    assert.equal(app.get('recordBtn').getAttribute('aria-label'), '停止錄影');
    app.run('stopRecording()'); await settle();
    assert.equal(app.get('recordBtn').getAttribute('aria-label'), '開始錄影');
});
test('the folded effects control reflects current rendering settings', async () => {
    const app = setup(); await settle();
    app.run("setMode('pixel'); setColorTheme('ccd');");
    assert.equal(app.get('effectsSummary').textContent, '8-bit · CCD');
    app.ctx.isBlackMistEnabled = () => true; app.run('updateEffectsSummary()');
    assert.equal(app.get('effectsSummary').textContent, '8-bit · CCD · 柔焦');
});
test('taking a photo folds effects and makes the last-photo thumbnail available', async () => {
    const app = setup(); await settle(); app.run('processFrame(100)');
    app.get('effectsMenu').open = true;
    await app.run('takeSnapshot()');
    assert.equal(app.get('effectsMenu').open, false);
    assert.equal(app.get('lastPhotoBtn').disabled, false);
    assert.equal(app.get('lastPhotoThumb').src, app.get('photoResult').src);
    app.run('closeModal(); showLastPhoto()');
    assert.equal(app.get('photoModal').open, true);
});
