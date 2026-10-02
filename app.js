const video = document.getElementById('webcam');
const hiddenCanvas = document.getElementById('hiddenCanvas');
const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
const warpCanvas = document.getElementById('warpCanvas');
const warpCtx = warpCanvas.getContext('2d', { willReadFrequently: true });
const asciiCanvas = document.getElementById('asciiCanvas');
const asciiCtx = asciiCanvas.getContext('2d');
const pixelCanvas = document.getElementById('pixelCanvas');
const pixelCtx = pixelCanvas.getContext('2d');
const previewBox = document.getElementById('previewBox');
const asciiStamp = document.getElementById('asciiStamp');
const recordBtn = document.getElementById('recordBtn');
const recordIndicator = document.getElementById('recordIndicator');
const photoResult = document.getElementById('photoResult');
const videoResult = document.getElementById('videoResult');

let currentMode = 'ascii';
let captureKind = 'photo';
let colorTheme = 'green';
let facingMode = 'user';
let currentStream = null;
let captureAspect = null;
let cameraReady = false;
let cameraStarting = false;
let hasRenderedFrame = false;
let recordingBusy = false;
let recordingStream = null;
let lastFrameAt = -Infinity;
let ccdNoiseTick = 0;
let faceLoadPromise = null;
const captureHint = document.getElementById('captureHint');
const defaultCaptureHint = captureHint.textContent;

function updateEffectsSummary() {
    const modeLabel = currentMode === 'ascii' ? 'ASCII' : '8-bit';
    const themeLabel = { green: '經典綠', mono: '黑白', color: '彩色', ccd: 'CCD' }[colorTheme];
    document.getElementById('effectsSummary').textContent = `${modeLabel} · ${themeLabel}${window.isBlackMistEnabled?.() ? ' · 柔焦' : ''}`;
}

function closeEffectsMenu() {
    const menu = document.getElementById('effectsMenu');
    menu.open = false;
}

function setCaptureKind(kind) {
    if (recordingBusy || !['photo', 'video'].includes(kind)) return;
    captureKind = kind;
    closeEffectsMenu();
    document.getElementById('snapshotBtn').hidden = kind !== 'photo';
    recordBtn.hidden = kind !== 'video';
    for (const [id, value] of [['capturePhotoBtn', 'photo'], ['captureVideoBtn', 'video']]) {
        document.getElementById(id).classList.toggle('active', value === kind);
        document.getElementById(id).setAttribute('aria-pressed', String(value === kind));
    }
}

function showLastPhoto() {
    if (!currentPhotoBlob) return;
    closeEffectsMenu();
    openPreviewDialog('photoModal');
}

function updateCaptureControls() {
    const locked = cameraStarting || recordingBusy;
    for (const id of ['btnAscii', 'btnPixel', 'switchCameraBtn', 'capturePhotoBtn', 'captureVideoBtn']) {
        document.getElementById(id).disabled = locked;
    }
    document.getElementById('snapshotBtn').disabled = !cameraReady || !hasRenderedFrame;
    recordBtn.disabled = (!cameraReady || !hasRenderedFrame) && !recordingBusy;
    document.getElementById('lastPhotoBtn').disabled = recordingBusy || !currentPhotoBlob;
}

function setCameraStatus(message, retry = false) {
    document.getElementById('cameraStatus').hidden = !message;
    document.getElementById('cameraMessage').textContent = message;
    document.getElementById('retryCameraBtn').hidden = !retry;
}

function openPreviewDialog(id) {
    const dialog = document.getElementById(id);
    dialog.showModal();
    dialog.classList.add('show');
}

function closePreviewDialog(id) {
    const dialog = document.getElementById(id);
    dialog.classList.remove('show');
    dialog.close();
}


let switchCount = 0;
let isAlternateMode = false;
let faceLandmarker = null;
let isDetecting = false;
let lastFaceDetectionAt = 0;
const FACE_DETECTION_INTERVAL = 66;

let faceParams = {
    mx: 0.5, my: 0.65,
    leftX: 0.38, leftY: 0.62,
    rightX: 0.62, rightY: 0.62,
    leftEyeX: 0.4, leftEyeY: 0.42,
    rightEyeX: 0.6, rightEyeY: 0.42,
    openFactor: 1.0
};

let rafId = 0;
let frameCols = 0;
let frameRows = 0;
let lastVideoWidth = 0;
let lastVideoHeight = 0;
let pixelImageData = null;
let lastRenderedCanvas = asciiCanvas;
let currentPhotoBlob = null;
let currentVideoBlob = null;
let currentVideoUrl = '';
let mediaRecorder = null;
let recordedChunks = [];
let recordingStopTimer = 0;

const asciiChars = ' .`^\",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
const gbPalette = [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]];
const monoPalette = [[10, 10, 10], [80, 80, 80], [160, 160, 160], [240, 240, 240]];

async function initFaceLandmarker() {
    try {
        const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm');
        const filesetResolver = await vision.FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        );
        faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
                delegate: 'GPU'
            },
            runningMode: 'VIDEO',
            numFaces: 1
        });
    } catch (error) {
        console.warn('Face Landmarker initialization failed; alternate mode will use the last/default face position.', error);
    }
}

function stopAnimationLoop() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
    }
}

function startAnimationLoop() {
    stopAnimationLoop();
    rafId = requestAnimationFrame(processFrame);
}

async function initCamera() {
    if (cameraStarting || recordingBusy) return;
    captureAspect = window.matchMedia('(orientation: portrait)').matches ? 9 / 16 : null;
    cameraStarting = true;
    cameraReady = false;
    hasRenderedFrame = false;
    updateCaptureControls();
    setCameraStatus('正在啟動相機…請允許相機權限');
    stopAnimationLoop();

    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
    }

    setMode(currentMode);
    setColorTheme(colorTheme);

    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('CameraUnavailable');
        }
        currentStream = await navigator.mediaDevices.getUserMedia({
            video: {
                resizeMode: 'none',
                facingMode
            },
            audio: false
        });
        video.srcObject = currentStream;
        await video.play();
        if (captureAspect && video.videoWidth < video.videoHeight) {
            captureAspect = video.videoWidth / video.videoHeight;
        }
        configureFrameBuffers(true);
        cameraReady = true;
        setCameraStatus('');
        startAnimationLoop();
    } catch (error) {
        console.error('Camera access failed:', error);
        currentStream?.getTracks().forEach(track => track.stop());
        currentStream = null;
        const message = error.name === 'NotAllowedError'
            ? '相機權限未開啟。請在瀏覽器設定允許相機，再試一次。'
            : error.name === 'NotFoundError'
                ? '找不到可用的相機。請確認裝置已連接，再試一次。'
                : !window.isSecureContext
                    ? '請使用 HTTPS 或 localhost 開啟，才能使用相機。'
                    : '相機無法啟動。請關閉其他使用相機的程式，再試一次。';
        setCameraStatus(message, true);
    } finally {
        cameraStarting = false;
        updateCaptureControls();
    }
}

// Every third switch opens the hidden mode.
function switchCamera() {
    if (cameraStarting || recordingBusy) return;
    closeEffectsMenu();
    switchCount++;

    if (switchCount % 3 === 0) {
        isAlternateMode = true;
        faceLoadPromise ||= initFaceLandmarker();
        document.getElementById('mainTitle').classList.add('alternate-mode');
        asciiStamp.classList.add('glitch');
    } else {
        isAlternateMode = false;
        document.getElementById('mainTitle').classList.remove('alternate-mode');
        asciiStamp.classList.remove('glitch');
        facingMode = (facingMode === 'user') ? 'environment' : 'user';
        initCamera();
    }
}

function setMode(mode) {
    if (recordingBusy || !['ascii', 'pixel'].includes(mode)) return;
    currentMode = mode;
    updateEffectsSummary();
    hasRenderedFrame = false;
    updateCaptureControls();
    document.getElementById('btnAscii').classList.toggle('active', mode === 'ascii');
    document.getElementById('btnPixel').classList.toggle('active', mode === 'pixel');
    asciiCanvas.style.display = mode === 'ascii' ? 'block' : 'none';
    pixelCanvas.style.display = mode === 'pixel' ? 'block' : 'none';
    for (const [id, selected] of [['btnAscii', mode === 'ascii'], ['btnPixel', mode === 'pixel']]) {
        document.getElementById(id).setAttribute('aria-pressed', String(selected));
    }
    configureFrameBuffers(true);
}

function setColorTheme(theme) {
    if (!['green', 'mono', 'color', 'ccd'].includes(theme)) return;
    colorTheme = theme;
    updateEffectsSummary();
    document.getElementById('btnGreen').classList.toggle('active', theme === 'green');
    document.getElementById('btnMono').classList.toggle('active', theme === 'mono');
    document.getElementById('btnColor').classList.toggle('active', theme === 'color');
    document.getElementById('btnCcd').classList.toggle('active', theme === 'ccd');
    for (const [id, value] of [['btnGreen', 'green'], ['btnMono', 'mono'], ['btnColor', 'color'], ['btnCcd', 'ccd']]) {
        document.getElementById(id).setAttribute('aria-pressed', String(value === theme));
    }
}

function getFrameSize() {
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const videoAspect = captureAspect ? 1 / captureAspect : height / width;

    if (currentMode === 'ascii') {
        const cols = 85;
        const fontAspect = 3.6 / 6;
        return { cols, rows: Math.max(1, Math.floor((cols * videoAspect) / fontAspect)) };
    }

    const cols = 140;
    return { cols, rows: Math.max(1, Math.floor(cols * videoAspect)) };
}

function configureFrameBuffers(force = false) {
    if (!video.videoWidth || !video.videoHeight) return;

    const { cols, rows } = getFrameSize();
    const videoChanged = lastVideoWidth !== video.videoWidth || lastVideoHeight !== video.videoHeight;
    if (!force && !videoChanged && cols === frameCols && rows === frameRows) return;

    frameCols = cols;
    frameRows = rows;
    lastVideoWidth = video.videoWidth;
    lastVideoHeight = video.videoHeight;

    if (hiddenCanvas.width !== cols) hiddenCanvas.width = cols;
    if (hiddenCanvas.height !== rows) hiddenCanvas.height = rows;
    if (warpCanvas.width !== cols) warpCanvas.width = cols;
    if (warpCanvas.height !== rows) warpCanvas.height = rows;

    const pixelScale = 4;
    if (pixelCanvas.width !== cols * pixelScale) pixelCanvas.width = cols * pixelScale;
    if (pixelCanvas.height !== rows * pixelScale) pixelCanvas.height = rows * pixelScale;
    pixelCtx.imageSmoothingEnabled = false;

    const charWidth = 6;
    const lineHeight = 3.6;
    const pad = 10;
    if (asciiCanvas.width !== Math.ceil(cols * charWidth + pad * 2)) asciiCanvas.width = Math.ceil(cols * charWidth + pad * 2);
    if (asciiCanvas.height !== Math.ceil(rows * lineHeight + pad * 2)) asciiCanvas.height = Math.ceil(rows * lineHeight + pad * 2);

    pixelImageData = pixelCtx.createImageData(cols, rows);
    const canvas = currentMode === 'ascii' ? asciiCanvas : pixelCanvas;
    previewBox.style.setProperty('--preview-aspect', String(canvas.width / canvas.height));
}

function getFramePlacement() {
    const sourceAspect = video.videoWidth / video.videoHeight;
    const targetAspect = captureAspect || sourceAspect;
    const width = Math.min(1, sourceAspect / targetAspect);
    const height = Math.min(1, targetAspect / sourceAspect);
    return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

function drawVideoFrame(cols, rows) {
    hiddenCtx.setTransform(1, 0, 0, 1, 0, 0);
    hiddenCtx.fillStyle = '#000';
    hiddenCtx.fillRect(0, 0, cols, rows);
    hiddenCtx.save();
    if (facingMode === 'user') {
        hiddenCtx.translate(cols, 0);
        hiddenCtx.scale(-1, 1);
    }
    const placement = getFramePlacement();
    hiddenCtx.drawImage(video,
        placement.x * cols, placement.y * rows,
        placement.width * cols, placement.height * rows);
    hiddenCtx.restore();
}

function runFaceDetection(timestamp) {
    if (!faceLandmarker || video.paused || video.ended || isDetecting) return;
    if (timestamp - lastFaceDetectionAt < FACE_DETECTION_INTERVAL) return;

    isDetecting = true;
    lastFaceDetectionAt = timestamp;

    try {
        const results = faceLandmarker.detectForVideo(video, timestamp);
        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
            const lm = results.faceLandmarks[0];
            const placement = getFramePlacement();
            const getX = p => {
                const x = placement.x + p.x * placement.width;
                return facingMode === 'user' ? 1 - x : x;
            };
            const getY = p => placement.y + p.y * placement.height;

            const mouthX = (getX(lm[13]) + getX(lm[14])) / 2;
            const mouthY = (getY(lm[13]) + getY(lm[14])) / 2;
            const lx = getX(lm[78]);
            const ly = getY(lm[78]);
            const rx = getX(lm[308]);
            const ry = getY(lm[308]);
            const ley = (getY(lm[159]) + getY(lm[145])) / 2;
            const lex = getX(lm[33]);
            const rey = (getY(lm[386]) + getY(lm[374])) / 2;
            const rex = getX(lm[362]);
            const gap = Math.hypot(lm[14].x - lm[13].x, lm[14].y - lm[13].y);

            faceParams.mx = faceParams.mx * 0.8 + mouthX * 0.2;
            faceParams.my = faceParams.my * 0.8 + mouthY * 0.2;
            faceParams.leftX = faceParams.leftX * 0.8 + lx * 0.2;
            faceParams.leftY = faceParams.leftY * 0.8 + ly * 0.2;
            faceParams.rightX = faceParams.rightX * 0.8 + rx * 0.2;
            faceParams.rightY = faceParams.rightY * 0.8 + ry * 0.2;
            faceParams.leftEyeX = faceParams.leftEyeX * 0.8 + lex * 0.2;
            faceParams.leftEyeY = faceParams.leftEyeY * 0.8 + ley * 0.2;
            faceParams.rightEyeX = faceParams.rightEyeX * 0.8 + rex * 0.2;
            faceParams.rightEyeY = faceParams.rightEyeY * 0.8 + rey * 0.2;
            faceParams.openFactor = faceParams.openFactor * 0.8 + Math.max(1.0, gap * 25.0) * 0.2;
        }
    } catch (error) {
        console.warn('Face detection failed for this frame:', error);
    } finally {
        isDetecting = false;
    }
}

function applyCheshireSmileWarp(cols, rows) {
    warpCtx.setTransform(1, 0, 0, 1, 0, 0);
    warpCtx.clearRect(0, 0, cols, rows);
    warpCtx.drawImage(hiddenCanvas, 0, 0);

    const srcData = hiddenCtx.getImageData(0, 0, cols, rows);
    const srcPixels = srcData.data;

    const mx = faceParams.mx * cols;
    const my = faceParams.my * rows;
    const lx = faceParams.leftX * cols;
    const ly = faceParams.leftY * rows;
    const rx = faceParams.rightX * cols;
    const ry = faceParams.rightY * rows;
    const lex = faceParams.leftEyeX * cols;
    const ley = faceParams.leftEyeY * rows;
    const rex = faceParams.rightEyeX * cols;
    const rey = faceParams.rightEyeY * rows;

    const mouthWidth = Math.hypot(rx - lx, ry - ly) || cols * 0.3;
    const mouthRadius = mouthWidth * 1.1;
    const eyeRadius = mouthWidth * 0.45;

    const minX = Math.max(0, Math.floor(Math.min(mx - mouthRadius, lex - eyeRadius, rex - eyeRadius)));
    const maxX = Math.min(cols - 1, Math.ceil(Math.max(mx + mouthRadius, lex + eyeRadius, rex + eyeRadius)));
    const minY = Math.max(0, Math.floor(Math.min(my - mouthRadius, ley - eyeRadius, rey - eyeRadius)));
    const maxY = Math.min(rows - 1, Math.ceil(Math.max(my + mouthRadius, ley + eyeRadius, rey + eyeRadius)));
    if (maxX < minX || maxY < minY) return;
    const roiWidth = Math.max(1, maxX - minX + 1);
    const roiHeight = Math.max(1, maxY - minY + 1);
    const roi = warpCtx.getImageData(minX, minY, roiWidth, roiHeight);
    const dstPixels = roi.data;

    const mouthRadiusSq = mouthRadius * mouthRadius;
    const eyeRadiusSq = eyeRadius * eyeRadius;

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            let srcX = x;
            let srcY = y;

            const dMouthX = x - mx;
            const dMouthY = y - my;
            const mouthDistSq = dMouthX * dMouthX + dMouthY * dMouthY;

            if (mouthDistSq < mouthRadiusSq) {
                const distMouth = Math.sqrt(mouthDistSq);
                const ratio = distMouth / (mouthRadius * 0.55);
                const w = Math.exp(-(ratio * ratio));
                const normX = Math.max(-1, Math.min(1, dMouthX / (mouthWidth * 0.5)));
                const curveShiftY = (1.2 - 2.8 * normX * normX) * (mouthWidth * 0.28);
                srcY -= curveShiftY * w;

                if (Math.abs(normX) > 0.4) {
                    srcX -= Math.sign(dMouthX) * (mouthWidth * 0.15) * w;
                }
            }

            const leftDx = x - lex;
            const leftDy = y - ley;
            const leftEyeDistSq = leftDx * leftDx + leftDy * leftDy;
            if (leftEyeDistSq < eyeRadiusSq) {
                const dist = Math.sqrt(leftEyeDistSq);
                const wEye = 0.5 * (1 + Math.cos(Math.PI * dist / eyeRadius));
                srcX -= leftDx * 0.35 * wEye;
                srcY -= leftDy * 0.35 * wEye;
            }

            const rightDx = x - rex;
            const rightDy = y - rey;
            const rightEyeDistSq = rightDx * rightDx + rightDy * rightDy;
            if (rightEyeDistSq < eyeRadiusSq) {
                const dist = Math.sqrt(rightEyeDistSq);
                const wEye = 0.5 * (1 + Math.cos(Math.PI * dist / eyeRadius));
                srcX -= rightDx * 0.35 * wEye;
                srcY -= rightDy * 0.35 * wEye;
            }

            const sampleX = Math.max(0, Math.min(cols - 1, Math.round(srcX)));
            const sampleY = Math.max(0, Math.min(rows - 1, Math.round(srcY)));
            const srcIdx = (sampleY * cols + sampleX) * 4;
            const dstIdx = ((y - minY) * roiWidth + (x - minX)) * 4;
            dstPixels[dstIdx] = srcPixels[srcIdx];
            dstPixels[dstIdx + 1] = srcPixels[srcIdx + 1];
            dstPixels[dstIdx + 2] = srcPixels[srcIdx + 2];
            dstPixels[dstIdx + 3] = 255;
        }
    }

    warpCtx.putImageData(roi, minX, minY);
}

function getThemeColor(r, g, b, x, y) {
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

    if (colorTheme === 'green') {
        const index = Math.min(3, Math.floor((brightness / 255) * 4));
        return gbPalette[index];
    }

    if (colorTheme === 'mono') {
        const index = Math.min(3, Math.floor((brightness / 255) * 4));
        return monoPalette[index];
    }

    if (colorTheme === 'ccd') {
        const contrast = 1.08;
        const liftedR = (r - 128) * contrast + 128;
        const liftedG = (g - 128) * contrast + 128;
        const liftedB = (b - 128) * contrast + 128;
        const noise = (((x * 17 + y * 31 + ccdNoiseTick * 13) % 17) - 8) * 0.9;
        const highlight = Math.max(0, (brightness - 185) / 70);
        return [
            clamp255(liftedR + 9 * highlight + noise),
            clamp255(liftedG + 3 * highlight - noise * 0.15),
            clamp255(liftedB - 8 * highlight - noise * 0.7)
        ];
    }

    return [r, g, b];
}

function clamp255(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function renderAscii(pixels, cols, rows) {
    const charWidth = 6;
    const lineHeight = 3.6;
    const pad = 10;
    asciiCtx.setTransform(1, 0, 0, 1, 0, 0);
    asciiCtx.fillStyle = '#000';
    asciiCtx.fillRect(0, 0, asciiCanvas.width, asciiCanvas.height);
    asciiCtx.font = 'bold 7px "Courier New", monospace';
    asciiCtx.textBaseline = 'top';

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const idx = (y * cols + x) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            const charIdx = Math.floor((brightness / 255) * (asciiChars.length - 1));
            const ch = asciiChars[charIdx];
            const [tr, tg, tb] = getThemeColor(r, g, b, x, y);
            asciiCtx.fillStyle = `rgb(${tr},${tg},${tb})`;
            asciiCtx.fillText(ch, pad + x * charWidth, pad + y * lineHeight);
        }
    }

    if (colorTheme === 'ccd') addCcdOverlay(asciiCtx, asciiCanvas.width, asciiCanvas.height);
    lastRenderedCanvas = asciiCanvas;
}

function renderPixelArt(pixels, cols, rows) {
    if (!pixelImageData || pixelImageData.width !== cols || pixelImageData.height !== rows) {
        pixelImageData = pixelCtx.createImageData(cols, rows);
    }

    const out = pixelImageData.data;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const idx = (y * cols + x) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            let tr, tg, tb;

            if (colorTheme === 'color') {
                tr = Math.floor(r / 64) * 85;
                tg = Math.floor(g / 64) * 85;
                tb = Math.floor(b / 64) * 85;
            } else if (colorTheme === 'ccd') {
                [tr, tg, tb] = getThemeColor(r, g, b, x, y);
                tr = Math.round(tr / 32) * 32;
                tg = Math.round(tg / 32) * 32;
                tb = Math.round(tb / 32) * 32;
            } else {
                [tr, tg, tb] = getThemeColor(r, g, b, x, y);
            }

            out[idx] = clamp255(tr);
            out[idx + 1] = clamp255(tg);
            out[idx + 2] = clamp255(tb);
            out[idx + 3] = 255;
        }
    }

    const lowResCanvas = getLowResPixelCanvas(cols, rows);
    const lowResCtx = lowResCanvas.getContext('2d');
    lowResCtx.putImageData(pixelImageData, 0, 0);

    pixelCtx.setTransform(1, 0, 0, 1, 0, 0);
    pixelCtx.imageSmoothingEnabled = false;
    pixelCtx.clearRect(0, 0, pixelCanvas.width, pixelCanvas.height);
    pixelCtx.drawImage(lowResCanvas, 0, 0, pixelCanvas.width, pixelCanvas.height);

    if (colorTheme === 'ccd') addCcdOverlay(pixelCtx, pixelCanvas.width, pixelCanvas.height);
    lastRenderedCanvas = pixelCanvas;
}

let lowResPixelCanvas = null;
function getLowResPixelCanvas(cols, rows) {
    if (!lowResPixelCanvas) lowResPixelCanvas = document.createElement('canvas');
    if (lowResPixelCanvas.width !== cols) lowResPixelCanvas.width = cols;
    if (lowResPixelCanvas.height !== rows) lowResPixelCanvas.height = rows;
    return lowResPixelCanvas;
}

function addCcdOverlay(ctx, width, height) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const gradient = ctx.createRadialGradient(width * 0.5, height * 0.45, 0, width * 0.5, height * 0.45, Math.max(width, height) * 0.62);
    gradient.addColorStop(0, 'rgba(255,235,205,0.08)');
    gradient.addColorStop(0.6, 'rgba(255,180,120,0.02)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    ctx.save();
    const vignette = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.25, width / 2, height / 2, Math.max(width, height) * 0.72);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
}

function getY2KTimeString() {
    if (isAlternateMode) {
        const glitchArr = ["'99 12 31  23:59", "'66 06 06  06:66", "'?? ?? ??  ??:??", "'99 99 99  99:99"];
        if (Math.random() < 0.3) return glitchArr[Math.floor(Math.random() * glitchArr.length)];
        return `'${Math.floor(Math.random() * 90 + 10)} ${Math.floor(Math.random() * 90 + 10)} ${Math.floor(Math.random() * 90 + 10)}  ${Math.floor(Math.random() * 90 + 10)}:${Math.floor(Math.random() * 90 + 10)}`;
    }

    const now = new Date();
    const year = String(now.getFullYear()).slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    return `'${year} ${month} ${day}  ${hours}:${mins}`;
}

function drawY2KStampOnCanvas(ctx, width, height) {
    ctx.save();
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillStyle = isAlternateMode ? '#ff0033' : '#ff8c00';
    ctx.textAlign = 'right';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillText(getY2KTimeString(), width - 15, height - 12);
    ctx.restore();
}

function processFrame(timestamp) {
    if (timestamp - lastFrameAt < 1000 / 30) {
        rafId = requestAnimationFrame(processFrame);
        return;
    }
    lastFrameAt = timestamp;
    ccdNoiseTick = Math.floor(timestamp / 90);
    if (video.paused || video.ended) {
        rafId = requestAnimationFrame(processFrame);
        return;
    }

    configureFrameBuffers();
    const cols = frameCols;
    const rows = frameRows;
    if (!cols || !rows) {
        rafId = requestAnimationFrame(processFrame);
        return;
    }

    drawVideoFrame(cols, rows);

    if (isAlternateMode) {
        runFaceDetection(timestamp);
        applyCheshireSmileWarp(cols, rows);
    }

    const targetCtx = isAlternateMode ? warpCtx : hiddenCtx;
    const imgData = targetCtx.getImageData(0, 0, cols, rows);

    if (currentMode === 'ascii') {
        renderAscii(imgData.data, cols, rows);
        window.applyQuarterBlackMist?.(asciiCanvas);
        drawY2KStampOnCanvas(asciiCtx, asciiCanvas.width, asciiCanvas.height);
        asciiStamp.textContent = '';
    } else {
        renderPixelArt(imgData.data, cols, rows);
        window.applyQuarterBlackMist?.(pixelCanvas);
        drawY2KStampOnCanvas(pixelCtx, pixelCanvas.width, pixelCanvas.height);
        asciiStamp.textContent = '';
    }

    if (!hasRenderedFrame) {
        hasRenderedFrame = true;
        updateCaptureControls();
    }
    rafId = requestAnimationFrame(processFrame);
}

function flashPreview() {
    previewBox.classList.add('flash');
    window.setTimeout(() => previewBox.classList.remove('flash'), 200);
}

function canvasToBlob(canvas, type = 'image/png', quality) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function takeSnapshot() {
    if (!cameraReady || !hasRenderedFrame) return;
    closeEffectsMenu();
    flashPreview();

    const source = currentMode === 'ascii' ? asciiCanvas : pixelCanvas;
    const saveCanvas = document.createElement('canvas');
    saveCanvas.width = source.width;
    saveCanvas.height = source.height;
    const saveCtx = saveCanvas.getContext('2d');
    saveCtx.drawImage(source, 0, 0);

    currentPhotoBlob = await canvasToBlob(saveCanvas, 'image/png');
    if (!currentPhotoBlob) return;

    const dataUrl = URL.createObjectURL(currentPhotoBlob);
    const oldUrl = photoResult.dataset.objectUrl;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    photoResult.dataset.objectUrl = dataUrl;
    photoResult.src = dataUrl;
    document.getElementById('lastPhotoThumb').src = dataUrl;
    document.getElementById('lastPhotoThumb').hidden = false;
    document.getElementById('lastPhotoBtn').disabled = false;
    openPreviewDialog('photoModal');
}

async function shareCurrentPhoto() {
    if (!currentPhotoBlob) return;
    const file = new File([currentPhotoBlob], `y2k-cam-${Date.now()}.png`, { type: 'image/png' });

    try {
        if (navigator.canShare?.({ files: [file] }) && navigator.share) {
            await navigator.share({ files: [file], title: 'Y2K CAM' });
            return;
        }
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.warn('Photo sharing failed:', error);
    }

    const link = document.createElement('a');
    link.href = URL.createObjectURL(currentPhotoBlob);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function getRecorderMimeType() {
    const candidates = [
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
    ];
    return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecording();
        return;
    }
    await startRecording();
}

async function startRecording() {
    if (!cameraReady || !hasRenderedFrame || recordingBusy) return;
    closeEffectsMenu();
    if (!lastRenderedCanvas.captureStream || typeof MediaRecorder === 'undefined') {
        captureHint.textContent = '這個瀏覽器不支援錄影，仍可儲存照片。';
        return;
    }

    const canvas = currentMode === 'ascii' ? asciiCanvas : pixelCanvas;
    try {
        const stream = canvas.captureStream(30);
        recordingStream = stream;
        const mimeType = getRecorderMimeType();
        recordedChunks = [];
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = event => {
            if (event.data && event.data.size > 0) recordedChunks.push(event.data);
        };
        mediaRecorder.onstop = finishRecording;
        mediaRecorder.start(250);
        recordingBusy = true;
        updateCaptureControls();
        recordBtn.setAttribute('aria-pressed', 'true');
        captureHint.textContent = '錄影中 · 15 秒後自動停止';
        recordBtn.classList.add('recording');
        recordBtn.setAttribute('aria-label', '停止錄影');
        recordIndicator.classList.add('show');

        recordingStopTimer = window.setTimeout(() => {
            if (mediaRecorder?.state === 'recording') stopRecording();
        }, 15000);
    } catch (error) {
        console.error('Recording failed:', error);
        recordingStream?.getTracks().forEach(track => track.stop());
        recordingStream = null;
        captureHint.textContent = '無法開始錄影，請重試或改用其他瀏覽器。';
    }
}

function stopRecording() {
    if (recordingStopTimer) {
        clearTimeout(recordingStopTimer);
        recordingStopTimer = 0;
    }
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    recordBtn.setAttribute('aria-pressed', 'false');
    recordBtn.classList.remove('recording');
    recordBtn.setAttribute('aria-label', '開始錄影');
    recordIndicator.classList.remove('show');
}

function finishRecording() {
    const type = mediaRecorder?.mimeType || 'video/webm';
    currentVideoBlob = new Blob(recordedChunks, { type });
    recordedChunks = [];
    recordingStream?.getTracks().forEach(track => track.stop());
    recordingStream = null;
    recordingBusy = false;
    mediaRecorder = null;
    updateCaptureControls();
    captureHint.textContent = defaultCaptureHint;

    if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = URL.createObjectURL(currentVideoBlob);
    videoResult.src = currentVideoUrl;
    const download = document.getElementById('downloadVideoBtn');
    download.href = currentVideoUrl;
    download.download = type.includes('mp4') ? 'y2k-cam.mp4' : 'y2k-cam.webm';
    openPreviewDialog('videoModal');
}

async function shareCurrentVideo() {
    if (!currentVideoBlob) return;
    const extension = currentVideoBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([currentVideoBlob], `y2k-cam-${Date.now()}.${extension}`, { type: currentVideoBlob.type });

    try {
        if (navigator.canShare?.({ files: [file] }) && navigator.share) {
            await navigator.share({ files: [file], title: 'Y2K CAM' });
            return;
        }
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.warn('Video sharing failed:', error);
    }

    document.getElementById('downloadVideoBtn').click();
}

function closeModal() {
    closePreviewDialog('photoModal');
}

function closeVideoModal() {
    closePreviewDialog('videoModal');
    videoResult.pause();
}

function handleVisibilityChange() {
    if (document.hidden) {
        stopAnimationLoop();
        if (mediaRecorder?.state === 'recording') stopRecording();
    } else if (currentStream && !rafId) {
        startAnimationLoop();
    }
}

window.setCaptureKind = setCaptureKind;
window.showLastPhoto = showLastPhoto;
window.closeEffectsMenu = closeEffectsMenu;
window.updateEffectsSummary = updateEffectsSummary;
window.initCamera = initCamera;
window.setMode = setMode;
window.setColorTheme = setColorTheme;
window.switchCamera = switchCamera;
window.takeSnapshot = takeSnapshot;
window.shareCurrentPhoto = shareCurrentPhoto;
window.closeModal = closeModal;
window.toggleRecording = toggleRecording;
window.shareCurrentVideo = shareCurrentVideo;
window.closeVideoModal = closeVideoModal;

document.addEventListener('visibilitychange', handleVisibilityChange);
document.addEventListener('pointerdown', event => {
    const menu = document.getElementById('effectsMenu');
    if (menu.open && !menu.contains(event.target)) closeEffectsMenu();
});
document.addEventListener('keydown', event => {
    const menu = document.getElementById('effectsMenu');
    if (event.key === 'Escape' && menu.open) {
        closeEffectsMenu();
        menu.querySelector('summary').focus();
    }
});
window.addEventListener('pagehide', () => {
    stopAnimationLoop();
    if (mediaRecorder?.state === 'recording') stopRecording();
    currentStream?.getTracks().forEach(track => track.stop());
});

for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
        dialog.classList.remove('show');
        if (dialog.id === 'videoModal') videoResult.pause();
    });
}
window.addEventListener('pageshow', event => {
    if (event.persisted) initCamera();
});
initCamera();
