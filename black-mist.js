const asciiCanvas = document.getElementById('asciiCanvas');
const pixelCanvas = document.getElementById('pixelCanvas');
const blackMistButton = document.getElementById('btnBlackMist');
const previewBox = document.getElementById('previewBox');
const asciiStamp = document.getElementById('asciiStamp');

let blackMistEnabled = false;
let blackMistRafId = 0;

// Keep diffusion on a dedicated overlay canvas. The main renderer redraws the
// ASCII/pixel canvas every frame, so modifying that same canvas from a second
// RAF loop could be overwritten immediately and make the effect nearly invisible.
const mistCanvas = document.createElement('canvas');
const mistCtx = mistCanvas.getContext('2d');
mistCanvas.setAttribute('aria-hidden', 'true');
mistCanvas.style.position = 'absolute';
mistCanvas.style.inset = '0';
mistCanvas.style.width = '100%';
mistCanvas.style.height = '100%';
mistCanvas.style.pointerEvents = 'none';
mistCanvas.style.display = 'none';
mistCanvas.style.zIndex = '1';
previewBox.insertBefore(mistCanvas, asciiStamp);
asciiStamp.style.zIndex = '2';
const recordIndicator = document.getElementById('recordIndicator');
if (recordIndicator) recordIndicator.style.zIndex = '3';

function getVisibleRenderCanvas() {
    if (pixelCanvas.style.display === 'block') return pixelCanvas;
    return asciiCanvas;
}

function ensureMistSize(source) {
    if (mistCanvas.width !== source.width) mistCanvas.width = source.width;
    if (mistCanvas.height !== source.height) mistCanvas.height = source.height;
}

function renderBlackMistOverlay(source) {
    if (!source.width || !source.height) return;
    ensureMistSize(source);

    const w = mistCanvas.width;
    const h = mistCanvas.height;
    const blurPx = Math.max(4, Math.round(Math.min(w, h) * 0.018));

    mistCtx.setTransform(1, 0, 0, 1, 0, 0);
    mistCtx.clearRect(0, 0, w, h);

    // Stronger highlight diffusion: two blurred screen passes create the
    // characteristic soft halo around bright areas without blurring the base image.
    mistCtx.save();
    mistCtx.globalCompositeOperation = 'screen';
    mistCtx.globalAlpha = 0.34;
    mistCtx.filter = `blur(${blurPx}px) brightness(1.35) saturate(0.88)`;
    mistCtx.drawImage(source, 0, 0, w, h);
    mistCtx.restore();

    mistCtx.save();
    mistCtx.globalCompositeOperation = 'screen';
    mistCtx.globalAlpha = 0.16;
    mistCtx.filter = `blur(${Math.max(2, Math.round(blurPx * 0.45))}px) brightness(1.2)`;
    mistCtx.drawImage(source, 0, 0, w, h);
    mistCtx.restore();

    // Black diffusion also lowers perceived contrast and slightly lifts shadows.
    mistCtx.save();
    mistCtx.globalCompositeOperation = 'source-over';
    mistCtx.fillStyle = 'rgba(30, 24, 20, 0.055)';
    mistCtx.fillRect(0, 0, w, h);
    mistCtx.restore();
}

function blackMistLoop() {
    if (blackMistEnabled) {
        mistCanvas.style.display = 'block';
        renderBlackMistOverlay(getVisibleRenderCanvas());
    }
    blackMistRafId = requestAnimationFrame(blackMistLoop);
}

function toggleBlackMist() {
    blackMistEnabled = !blackMistEnabled;
    blackMistButton.classList.toggle('active', blackMistEnabled);
    blackMistButton.textContent = blackMistEnabled ? '黑柔焦 ON' : '黑柔焦 OFF';
    blackMistButton.setAttribute('aria-pressed', String(blackMistEnabled));

    if (!blackMistEnabled) {
        mistCanvas.style.display = 'none';
        mistCtx.clearRect(0, 0, mistCanvas.width, mistCanvas.height);
    }
}

window.toggleBlackMist = toggleBlackMist;
blackMistButton.setAttribute('aria-pressed', 'false');
blackMistRafId = requestAnimationFrame(blackMistLoop);

window.addEventListener('pagehide', () => {
    if (blackMistRafId) cancelAnimationFrame(blackMistRafId);
});
