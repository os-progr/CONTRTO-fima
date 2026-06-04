/* ============================================
   QOAN — Signature Pad Module
   Canvas-based digital signature with
   touch support and image upload fallback.
   ============================================ */

function initSignaturePad() {
    const canvas = document.getElementById('signature-pad');
    const btnClearSignature = document.getElementById('btn-clear-signature');
    const fileSignature = document.getElementById('file-signature');
    window.hasValidSignature = false;

    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let isDrawing = false;

    function resizeCanvas() {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        ctx.scale(ratio, ratio);
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }
    window.addEventListener('resize', resizeCanvas);
    setTimeout(resizeCanvas, 100);

    function getPos(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function startPosition(e) {
        if (e.cancelable) e.preventDefault();
        isDrawing = true;
        const pos = getPos(e);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    }

    function endPosition() {
        isDrawing = false;
        ctx.beginPath();
    }

    function draw(e) {
        if (!isDrawing) return;
        if (e.cancelable) e.preventDefault();

        if (!window.hasValidSignature) {
            window.hasValidSignature = true;
            if (typeof updateProgress === 'function') updateProgress();
        }

        const pos = getPos(e);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    }

    canvas.addEventListener('mousedown', startPosition);
    canvas.addEventListener('mouseup', endPosition);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseout', endPosition);
    canvas.addEventListener('touchstart', startPosition, { passive: false });
    canvas.addEventListener('touchend', endPosition);
    canvas.addEventListener('touchmove', draw, { passive: false });

    if (btnClearSignature) {
        btnClearSignature.addEventListener('click', () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            window.hasValidSignature = false;
            if (fileSignature) fileSignature.value = '';
        });
    }

    if (fileSignature) {
        fileSignature.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                window.hasValidSignature = true;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#1a1a1a';
                ctx.font = 'bold 16px Inter';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('\u2713 Foto de firma cargada', canvas.offsetWidth / 2, canvas.offsetHeight / 2);
                if (typeof updateProgress === 'function') updateProgress();
            }
        });
    }
}
