const videoModal = document.getElementById('videoModal');
const videoResult = document.getElementById('videoResult');
const videoTip = videoModal.querySelector('.modal-tip');
const shareVideoBtn = document.getElementById('shareVideoBtn');
const downloadVideoBtn = document.getElementById('downloadVideoBtn');

const FFMPEG_VERSION = '0.12.15';
const FFMPEG_CORE_VERSION = '0.12.10';
const FFMPEG_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;

let ffmpeg = null;
let ffmpegLoadPromise = null;
let convertedVideoBlob = null;
let convertedVideoUrl = '';
let conversionInProgress = false;
let conversionSerial = 0;
let lastHandledSource = '';

async function fetchAsBlobUrl(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    const data = await response.arrayBuffer();
    return URL.createObjectURL(new Blob([data], { type: mimeType }));
}

async function createClassWorkerUrl() {
    const response = await fetch(`${FFMPEG_BASE}/worker.js`);
    if (!response.ok) throw new Error(`Failed to load FFmpeg worker: ${response.status}`);

    let workerSource = await response.text();
    workerSource = workerSource
        .replaceAll('"./const.js"', `"${FFMPEG_BASE}/const.js"`)
        .replaceAll('"./errors.js"', `"${FFMPEG_BASE}/errors.js"`);

    return URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
}

async function ensureFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (ffmpegLoadPromise) return ffmpegLoadPromise;

    ffmpegLoadPromise = (async () => {
        const { FFmpeg } = await import(`${FFMPEG_BASE}/classes.js`);
        const instance = new FFmpeg();

        instance.on('progress', ({ progress }) => {
            if (!conversionInProgress || !Number.isFinite(progress)) return;
            const percent = Math.max(0, Math.min(99, Math.round(progress * 100)));
            videoTip.textContent = `正在轉換 MP4… ${percent}%`;
        });

        const [coreURL, wasmURL, classWorkerURL] = await Promise.all([
            fetchAsBlobUrl(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
            fetchAsBlobUrl(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
            createClassWorkerUrl()
        ]);

        await instance.load({ coreURL, wasmURL, classWorkerURL });
        ffmpeg = instance;
        return instance;
    })();

    try {
        return await ffmpegLoadPromise;
    } catch (error) {
        ffmpegLoadPromise = null;
        throw error;
    }
}

function setConversionControls(enabled) {
    shareVideoBtn.disabled = !enabled;
    downloadVideoBtn.style.pointerEvents = enabled ? '' : 'none';
    downloadVideoBtn.style.opacity = enabled ? '' : '0.45';
    downloadVideoBtn.setAttribute('aria-disabled', String(!enabled));
}

async function transcodeToMp4(sourceBlob) {
    const engine = await ensureFFmpeg();
    const inputName = sourceBlob.type.includes('mp4') ? 'input.mp4' : 'input.webm';
    const outputName = 'output.mp4';

    try {
        await engine.deleteFile(inputName).catch(() => {});
        await engine.deleteFile(outputName).catch(() => {});
        await engine.writeFile(inputName, new Uint8Array(await sourceBlob.arrayBuffer()));

        let exitCode = await engine.exec([
            '-i', inputName,
            '-an',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            outputName
        ]);

        if (exitCode !== 0) {
            await engine.deleteFile(outputName).catch(() => {});
            exitCode = await engine.exec([
                '-i', inputName,
                '-an',
                '-c:v', 'mpeg4',
                '-q:v', '4',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                outputName
            ]);
        }

        if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);

        const output = await engine.readFile(outputName);
        return new Blob([output.buffer], { type: 'video/mp4' });
    } finally {
        await engine.deleteFile(inputName).catch(() => {});
        await engine.deleteFile(outputName).catch(() => {});
    }
}

async function processLatestRecording() {
    const sourceUrl = videoResult.src;
    if (!sourceUrl || sourceUrl === lastHandledSource || conversionInProgress) return;

    const serial = ++conversionSerial;
    lastHandledSource = sourceUrl;
    conversionInProgress = true;
    convertedVideoBlob = null;
    setConversionControls(false);
    videoTip.textContent = '正在準備 MP4 轉換…';

    try {
        const response = await fetch(sourceUrl);
        const sourceBlob = await response.blob();

        if (sourceBlob.type.includes('mp4')) {
            convertedVideoBlob = sourceBlob;
        } else {
            videoTip.textContent = '正在轉換 MP4…';
            convertedVideoBlob = await transcodeToMp4(sourceBlob);
        }

        if (serial !== conversionSerial) return;

        if (convertedVideoUrl) URL.revokeObjectURL(convertedVideoUrl);
        convertedVideoUrl = URL.createObjectURL(convertedVideoBlob);
        videoResult.src = convertedVideoUrl;
        downloadVideoBtn.href = convertedVideoUrl;
        downloadVideoBtn.download = 'y2k-cam.mp4';
        videoTip.textContent = 'MP4 轉換完成，可以播放、分享或儲存';
        setConversionControls(true);
    } catch (error) {
        console.error('MP4 conversion failed:', error);
        videoTip.textContent = 'MP4 轉換失敗，目前保留原始錄影格式';
        setConversionControls(true);
    } finally {
        if (serial === conversionSerial) conversionInProgress = false;
    }
}

async function shareConvertedVideo() {
    if (conversionInProgress) {
        alert('影片正在轉換成 MP4。');
        return;
    }

    if (!convertedVideoBlob) {
        downloadVideoBtn.click();
        return;
    }

    const file = new File([convertedVideoBlob], `y2k-cam-${Date.now()}.mp4`, { type: 'video/mp4' });

    try {
        if (navigator.canShare?.({ files: [file] }) && navigator.share) {
            await navigator.share({ files: [file], title: 'Y2K CAM' });
            return;
        }
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.warn('MP4 sharing failed:', error);
    }

    const link = document.createElement('a');
    link.href = URL.createObjectURL(convertedVideoBlob);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

window.shareCurrentVideo = shareConvertedVideo;

const modalObserver = new MutationObserver(() => {
    if (videoModal.classList.contains('show')) {
        queueMicrotask(processLatestRecording);
    }
});

modalObserver.observe(videoModal, { attributes: true, attributeFilter: ['class'] });

window.addEventListener('pagehide', () => {
    modalObserver.disconnect();
    conversionSerial++;
    if (convertedVideoUrl) URL.revokeObjectURL(convertedVideoUrl);
    ffmpeg?.terminate();
});
