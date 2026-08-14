const asciiCanvas = document.getElementById('asciiCanvas');
const pixelCanvas = document.getElementById('pixelCanvas');
const blackMistButton = document.getElementById('btnBlackMist');

const bloomCanvas = document.createElement('canvas');
const bloomCtx = bloomCanvas.getContext('2d');

let blackMistEnabled = false;
let blackMistRafId = 0;

function ensureBloomSize(canvas) {
    if (bloomCanvas.width !== canvas.width) bloomCanvas.width = canvas.width;
    if (bloomCanvas.height !== canvas.height) bloomCanvas.height = canvas.height;
}

function getVisibleRenderCanvas() {
    if (pixelCanvas.style.display === 'block') return pixelCanvas;
    return asciiCanvas;
}

function applyBlackMist(canvas) {
    if (!canvas.width || !canvas.height) return;

    ensureBloomSize(canvas);

    bloomCtx.setTransform(1, 0, 0, 1, 0, 0);
    bloomCtx.globalCompositeOperation = 'source-over';
    bloomCtx.globalAlpha = 1;
    bloomCtx.filter = 'none';
    bloomCtx.clearRect(0, 0, bloomCanvas.width, bloomCanvas.height);
    bloomCtx.drawImage(canvas, 0, 0);

    const ctx = canvas.getContext('2d');
    ctx.save();

    // A soft, low-opacity screen blend gives bright areas a diffusion halo
    // while keeping edges and darker regions substantially intact.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.18;
    ctx.filter = `blur(${Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.009))}px) brightness(1.16) saturate(0.94)`;
    ctx.drawImage(bloomCanvas, 0, 0);

    // Slightly lift the deepest blacks, similar to light scattering in a
    // physical black diffusion filter rather than applying a full-frame blur.
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(24, 20, 17, 0.035)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.restore();
}

function blackMistLoop() {
    if (blackMistEnabled) {
        applyBlackMist(getVisibleRenderCanvas());
    }
    blackMistRafId = requestAnimationFrame(blackMistLoop);
}

function toggleBlackMist() {
    blackMistEnabled = !blackMistEnabled;
    blackMistButton.classList.toggle('active', blackMistEnabled);
    blackMistButton.textContent = blackMistEnabled ? '黑柔焦 ON' : '黑柔焦 OFF';
    blackMistButton.setAttribute('aria-pressed', String(blackMistEnabled));
}

window.toggleBlackMist = toggleBlackMist;
blackMistButton.setAttribute('aria-pressed', 'false');
blackMistRafId = requestAnimationFrame(blackMistLoop);

window.addEventListener('pagehide', () => {
    if (blackMistRafId) cancelAnimationFrame(blackMistRafId);
});
