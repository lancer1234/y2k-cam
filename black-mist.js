const asciiCanvas = document.getElementById('asciiCanvas');
const pixelCanvas = document.getElementById('pixelCanvas');
const blackMistButton = document.getElementById('btnBlackMist');

const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d');
const highlightCanvas = document.createElement('canvas');
const highlightCtx = highlightCanvas.getContext('2d', { willReadFrequently: true });

let blackMistEnabled = false;

function ensureBuffers(canvas) {
    if (sourceCanvas.width !== canvas.width) sourceCanvas.width = canvas.width;
    if (sourceCanvas.height !== canvas.height) sourceCanvas.height = canvas.height;
    if (highlightCanvas.width !== canvas.width) highlightCanvas.width = canvas.width;
    if (highlightCanvas.height !== canvas.height) highlightCanvas.height = canvas.height;
}

function extractHighlights(canvas) {
    highlightCtx.setTransform(1, 0, 0, 1, 0, 0);
    highlightCtx.globalCompositeOperation = 'source-over';
    highlightCtx.globalAlpha = 1;
    highlightCtx.filter = 'none';
    highlightCtx.clearRect(0, 0, highlightCanvas.width, highlightCanvas.height);
    highlightCtx.drawImage(canvas, 0, 0);

    const imageData = highlightCtx.getImageData(0, 0, highlightCanvas.width, highlightCanvas.height);
    const data = imageData.data;

    // Tuned to approximate a 1/4 black diffusion filter: highlights begin to
    // bloom before clipping, while midtones and edges retain most of their detail.
    const threshold = 168;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;

        if (luma < threshold) {
            data[i + 3] = 0;
            continue;
        }

        const strength = Math.min(1, (luma - threshold) / 87);

        // Physical black diffusion tends to produce a subtly warmer, softer
        // highlight rolloff rather than a neutral white glow.
        data[i] = Math.min(255, r + 12 * strength);
        data[i + 1] = Math.min(255, g + 6 * strength);
        data[i + 2] = Math.max(0, b - 3 * strength);
        data[i + 3] = Math.round(255 * strength);
    }

    highlightCtx.putImageData(imageData, 0, 0);
}

function applyQuarterBlackMist(canvas) {
    if (!blackMistEnabled || !canvas || !canvas.width || !canvas.height) return;

    ensureBuffers(canvas);

    sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
    sourceCtx.globalCompositeOperation = 'source-over';
    sourceCtx.globalAlpha = 1;
    sourceCtx.filter = 'none';
    sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    sourceCtx.drawImage(canvas, 0, 0);

    extractHighlights(sourceCanvas);

    const ctx = canvas.getContext('2d');
    const minSide = Math.min(canvas.width, canvas.height);
    const blurNear = Math.max(2, Math.round(minSide * 0.006));
    const blurFar = Math.max(6, Math.round(minSide * 0.018));

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sourceCanvas, 0, 0);

    // Near halo: restrained diffusion close to highlight edges.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.20;
    ctx.filter = `blur(${blurNear}px) brightness(1.05) saturate(0.97)`;
    ctx.drawImage(highlightCanvas, 0, 0);

    // Far halo: broader, lower-opacity scattering characteristic of 1/4 strength.
    ctx.globalAlpha = 0.14;
    ctx.filter = `blur(${blurFar}px) brightness(1.14) saturate(0.92)`;
    ctx.drawImage(highlightCanvas, 0, 0);

    // Slight shadow lift / contrast compression without washing the whole frame.
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.032;
    ctx.fillStyle = 'rgb(42, 36, 32)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Very subtle warm scattering tint.
    ctx.globalAlpha = 0.022;
    ctx.fillStyle = 'rgb(255, 229, 214)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.restore();
}

function toggleBlackMist() {
    blackMistEnabled = !blackMistEnabled;
    blackMistButton.classList.toggle('active', blackMistEnabled);
    blackMistButton.textContent = blackMistEnabled ? '黑柔焦 ON' : '黑柔焦 OFF';
    blackMistButton.setAttribute('aria-pressed', String(blackMistEnabled));
}

window.toggleBlackMist = toggleBlackMist;
window.isBlackMistEnabled = () => blackMistEnabled;
window.applyQuarterBlackMist = applyQuarterBlackMist;

blackMistButton.setAttribute('aria-pressed', 'false');
