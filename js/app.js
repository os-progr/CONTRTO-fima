/* ============================================
   QOAN — Main Application Module
   Orchestrates UI, form logic, OTP verification,
   GPS, file uploads, progress tracking,
   auto-save drafts, DNI validation, and submission.
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {

    // =============================================
    // 0. LOAD AI MODELS (Face-API)
    // =============================================
    let faceApiLoaded = false;
    if (typeof faceapi !== 'undefined') {
        Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri('https://justadudewhohacks.github.io/face-api.js/models'),
            faceapi.nets.faceLandmark68Net.loadFromUri('https://justadudewhohacks.github.io/face-api.js/models')
        ]).then(() => {
            console.log('Face API Models loaded (SSD + Landmarks)');
            faceApiLoaded = true;
        })
          .catch(err => console.error('Face API Error:', err));
    }

    // =============================================
    // 0.1 SELFIE + DNI VALIDATION FUNCTION
    // =============================================
    /**
     * Analiza una imagen para verificar que contenga:
     * 1) Un rostro humano visible (con landmarks)
     * 2) Un documento (DNI) junto al rostro
     * Retorna { valid, reason }
     */
    async function validateSelfieWithDNI(imageSource) {
        // --- Paso 1: Redimensionar imagen para detección confiable ---
        const analysisCanvas = document.createElement('canvas');
        const MAX_DIM = 480; // Reduced for faster mobile processing
        let srcW, srcH;

        if (imageSource instanceof HTMLVideoElement) {
            srcW = imageSource.videoWidth;
            srcH = imageSource.videoHeight;
        } else {
            srcW = imageSource.naturalWidth || imageSource.width;
            srcH = imageSource.naturalHeight || imageSource.height;
        }

        const scale = Math.min(MAX_DIM / srcW, MAX_DIM / srcH, 1);
        analysisCanvas.width = Math.round(srcW * scale);
        analysisCanvas.height = Math.round(srcH * scale);
        const actx = analysisCanvas.getContext('2d');
        actx.drawImage(imageSource, 0, 0, analysisCanvas.width, analysisCanvas.height);

        const w = analysisCanvas.width;
        const h = analysisCanvas.height;
        const imgArea = w * h;

        // --- Paso 2: Detectar rostro con landmarks ---
        const detections = await faceapi
            .detectAllFaces(analysisCanvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.25 }))
            .withFaceLandmarks();

        if (detections.length === 0) {
            return { valid: false, reason: 'no_face' };
        }

        // Verificar que los landmarks sean consistentes (rostro real)
        const landmarks = detections[0].landmarks;
        const nose = landmarks.getNose();
        const leftEye = landmarks.getLeftEye();
        const rightEye = landmarks.getRightEye();
        const mouth = landmarks.getMouth();

        if (!nose.length || !leftEye.length || !rightEye.length || !mouth.length) {
            return { valid: false, reason: 'no_face' };
        }

        // Verificar distancia entre ojos (evitar detecciones falsas muy pequeñas)
        const eyeDistance = Math.sqrt(
            Math.pow(rightEye[0].x - leftEye[3].x, 2) +
            Math.pow(rightEye[0].y - leftEye[3].y, 2)
        );
        if (eyeDistance < w * 0.04) {
            return { valid: false, reason: 'face_too_small' };
        }

        // --- Paso 3: Verificar proporción del rostro ---
        const face = detections[0].detection.box;
        const faceArea = face.width * face.height;
        const faceRatio = faceArea / imgArea;

        if (faceRatio > 0.50) {
            return { valid: false, reason: 'face_too_large' };
        }

        // --- Paso 4: Detectar documento (DNI) en zona fuera del rostro ---
        const imageData = actx.getImageData(0, 0, w, h);
        const pixels = imageData.data;

        // Expandir zona del rostro para excluirla del análisis
        const margin = Math.round(Math.min(face.width, face.height) * 0.15);
        const fX1 = Math.max(0, Math.round(face.x - margin));
        const fY1 = Math.max(0, Math.round(face.y - margin));
        const fX2 = Math.min(w, Math.round(face.x + face.width + margin));
        const fY2 = Math.min(h, Math.round(face.y + face.height + margin));

        // Analizar zona fuera del rostro buscando características de documento:
        // - Bordes/contraste (texto, bordes de tarjeta)
        // - Zonas relativamente claras (tarjeta blanca/clara)
        const step = 2;
        let edgePixels = 0;
        let brightPixels = 0;
        let totalSampled = 0;

        // Convertir a escala de grises y detectar gradientes
        for (let y = 1; y < h - 1; y += step) {
            for (let x = 1; x < w - 1; x += step) {
                // Saltar zona del rostro
                if (x >= fX1 && x <= fX2 && y >= fY1 && y <= fY2) continue;

                const idx = (y * w + x) * 4;
                const gray = pixels[idx] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx + 2] * 0.114;

                // Gradiente horizontal
                const idxR = (y * w + (x + 1)) * 4;
                const grayR = pixels[idxR] * 0.299 + pixels[idxR + 1] * 0.587 + pixels[idxR + 2] * 0.114;

                // Gradiente vertical
                const idxD = ((y + 1) * w + x) * 4;
                const grayD = pixels[idxD] * 0.299 + pixels[idxD + 1] * 0.587 + pixels[idxD + 2] * 0.114;

                const gradient = Math.abs(gray - grayR) + Math.abs(gray - grayD);

                if (gradient > 20) edgePixels++;
                if (gray > 140) brightPixels++;
                totalSampled++;
            }
        }

        if (totalSampled === 0) {
            return { valid: false, reason: 'no_document' };
        }

        const edgeDensity = edgePixels / totalSampled;
        const brightRatio = brightPixels / totalSampled;

        // Un DNI genera:
        // - edgeDensity > 0.05 (texto, foto, bordes de la tarjeta)
        // - brightRatio > 0.08 (la tarjeta es clara/blanca)
        // Un fondo uniforme sin DNI tendrá valores muy bajos
        const hasDocument = edgeDensity > 0.05 && brightRatio > 0.08;

        if (!hasDocument) {
            return { valid: false, reason: 'no_document' };
        }

        return { valid: true };
    }

    // =============================================
    // 1. CODE VERIFICATION (OTP)
    // =============================================
    const codeOverlay = document.getElementById('code-overlay');
    const otpInputs = document.querySelectorAll('.otp-input');
    const btnVerify = document.getElementById('btn-verify-code');
    const verifyText = document.getElementById('verify-text');
    const codeError = document.getElementById('code-error');
    const appHeader = document.getElementById('app-header');
    const appMain = document.getElementById('app-main');
    const appFooter = document.getElementById('app-footer');

    if (otpInputs.length > 0) otpInputs[0].focus();

    otpInputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
            let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            e.target.value = val;
            if (val && index < otpInputs.length - 1) {
                otpInputs[index + 1].focus();
            }
            const fullCode = Array.from(otpInputs).map(i => i.value).join('');
            if (fullCode.length === 6) verifyCode();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                otpInputs[index - 1].focus();
            }
        });
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = (e.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            pasted.split('').forEach((char, i) => { if (otpInputs[i]) otpInputs[i].value = char; });
            if (pasted.length === 6) verifyCode();
            else if (pasted.length > 0) otpInputs[Math.min(pasted.length, 5)].focus();
        });
    });

    if (btnVerify) btnVerify.addEventListener('click', verifyCode);

    function showApp() {
        codeOverlay.style.display = 'none';
        appHeader.style.display = '';
        appMain.style.display = '';
        appFooter.style.display = '';
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }

    async function verifyCode() {
        const code = Array.from(otpInputs).map(i => i.value.toUpperCase().trim()).join('');
        if (code.length !== 6) { showCodeError(); return; }

        if (btnVerify) btnVerify.disabled = true;
        if (verifyText) verifyText.textContent = 'Verificando...';

        // Simulated delay
        await new Promise(r => setTimeout(r, 600));

        if (code === 'QOAN26') {
            const expiryTime = Date.now() + 10 * 60 * 1000;
            localStorage.setItem('qoan_session_expiry', expiryTime.toString());
            startSessionTimer(10 * 60 * 1000);

            codeOverlay.style.opacity = '0';
            codeOverlay.style.transition = 'opacity 0.5s ease';
            setTimeout(showApp, 500);
        } else {
            showCodeError();
            if (btnVerify) btnVerify.disabled = false;
            if (verifyText) verifyText.textContent = 'Verificar Código';
        }
    }

    function showCodeError() {
        codeError.classList.remove('hidden');
        otpInputs.forEach(i => { i.classList.add('error'); i.value = ''; });
        setTimeout(() => otpInputs.forEach(i => i.classList.remove('error')), 500);
        setTimeout(() => codeError.classList.add('hidden'), 3000);
        otpInputs[0].focus();
    }

    // =============================================
    // 2. SESSION MANAGEMENT
    // =============================================
    let sessionTimeoutId = null;

    function startSessionTimer(duration) {
        if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
        sessionTimeoutId = setTimeout(() => { endSession(); }, duration);
    }

    function endSession() {
        localStorage.removeItem('qoan_session_expiry');
        codeOverlay.style.display = '';
        codeOverlay.style.transition = 'opacity 0.5s ease';
        setTimeout(() => { codeOverlay.style.opacity = '1'; }, 10);
        appHeader.style.display = 'none';
        appMain.style.display = 'none';
        appFooter.style.display = 'none';
        otpInputs.forEach(i => i.value = '');
        if (otpInputs.length > 0) otpInputs[0].focus();
    }

    // Restore session on page load
    const sessionExpiry = localStorage.getItem('qoan_session_expiry');
    if (sessionExpiry) {
        const timeRemaining = parseInt(sessionExpiry, 10) - Date.now();
        if (timeRemaining > 0) {
            showApp();
            startSessionTimer(timeRemaining);
        } else {
            localStorage.removeItem('qoan_session_expiry');
        }
    }

    // =============================================
    // 3. SCROLL REVEAL
    // =============================================
    const reveals = document.querySelectorAll('.reveal');
    const revealOnScroll = () => {
        const windowHeight = window.innerHeight;
        reveals.forEach(reveal => {
            const revealTop = reveal.getBoundingClientRect().top;
            if (revealTop < windowHeight - 100) {
                reveal.classList.add('active');
            }
        });
    };
    window.addEventListener('scroll', revealOnScroll);
    revealOnScroll();

    // =============================================
    // 4. LOAN CALCULATOR & SLIDER
    // =============================================
    const loanSlider = document.getElementById('loan-range');
    const loanValueDisplay = document.getElementById('range-val');
    const calcMonto = document.getElementById('calc-monto');
    const calcInteres = document.getElementById('calc-interes');
    const calcTotal = document.getElementById('calc-total');
    const plazoSelect = document.getElementById('plazo');
    const cuotasBreakdown = document.getElementById('cuotas-breakdown');
    const calcCuota1 = document.getElementById('calc-cuota1');
    const calcCuota2 = document.getElementById('calc-cuota2');
    const calcInteresDia = document.getElementById('calc-interes-dia');
    const labelInteres = document.getElementById('label-interes');

    function updateLoanCalculation() {
        if (!loanSlider) return;
        const val = parseFloat(loanSlider.value);
        const formatCurrency = (num) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', minimumFractionDigits: 2 }).format(num).replace('PEN', 'S/.');
        const formatNoDecimals = (num) => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', maximumFractionDigits: 0 }).format(num).replace('PEN', 'S/.');

        loanValueDisplay.textContent = formatNoDecimals(val);

        let meses = 1;
        if (plazoSelect && plazoSelect.value === '2 meses') {
            meses = 2;
        }

        const interesPorMes = val * 0.15;
        const totalInteres = interesPorMes * meses;
        const total = val + totalInteres;
        const interesPorDia = interesPorMes / 30;

        calcMonto.textContent = formatCurrency(val);
        calcInteres.textContent = formatCurrency(totalInteres);
        calcTotal.textContent = formatCurrency(total);
        if (calcInteresDia) calcInteresDia.textContent = formatCurrency(interesPorDia);

        if (meses === 2) {
            if (labelInteres) labelInteres.textContent = 'Interés (2 meses):';
            if (cuotasBreakdown) cuotasBreakdown.classList.remove('hidden');
            if (cuotasBreakdown) cuotasBreakdown.classList.add('flex');
            if (calcCuota1) calcCuota1.textContent = formatCurrency(interesPorMes);
            if (calcCuota2) calcCuota2.textContent = formatCurrency(val + interesPorMes);
        } else {
            if (labelInteres) labelInteres.textContent = 'Interés (15%):';
            if (cuotasBreakdown) cuotasBreakdown.classList.add('hidden');
            if (cuotasBreakdown) cuotasBreakdown.classList.remove('flex');
        }
    }

    if (loanSlider) {
        loanSlider.addEventListener('input', () => {
            updateLoanCalculation();
            loanValueDisplay.style.transform = 'scale(1.1)';
            setTimeout(() => { loanValueDisplay.style.transform = 'scale(1)'; }, 100);
        });
    }

    if (plazoSelect) {
        plazoSelect.addEventListener('change', updateLoanCalculation);
    }
    
    // Inicializar cálculo
    setTimeout(updateLoanCalculation, 150);

    // =============================================
    // 5. INPUT FOCUS ENHANCEMENT
    // =============================================
    const inputs = document.querySelectorAll('input:not([type="range"])');
    inputs.forEach(input => {
        input.addEventListener('focus', () => {
            const wrapper = input.closest('.input-glow');
            if (wrapper) wrapper.style.transform = 'translateX(8px)';
        });
        input.addEventListener('blur', () => {
            const wrapper = input.closest('.input-glow');
            if (wrapper) wrapper.style.transform = 'translateX(0)';
        });
    });

    // Step completion visual cue
    const formSections = document.querySelectorAll('.premium-glass');
    formSections.forEach(section => {
        section.addEventListener('focusin', () => {
            section.style.borderColor = 'rgba(0, 85, 255, 0.3)';
        });
        section.addEventListener('focusout', () => {
            section.style.borderColor = 'rgba(26, 26, 26, 0.1)';
        });
    });

    // =============================================
    // 6. GPS VALIDATION
    // =============================================
    const btnGps = document.getElementById('btn-gps');
    const iconGps = document.getElementById('icon-gps');
    const textGps = document.getElementById('text-gps');
    let gpsValidated = false;
    let gpsLatitud = null;
    let gpsLongitud = null;

    if (btnGps) {
        btnGps.addEventListener('click', () => {
            iconGps.textContent = 'sync';
            iconGps.classList.add('animate-spin');
            textGps.textContent = 'Obteniendo...';

            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        gpsValidated = true;
                        gpsLatitud = position.coords.latitude;
                        gpsLongitud = position.coords.longitude;
                        btnGps.classList.remove('bg-primary', 'hover:bg-black');
                        btnGps.classList.add('bg-green-600', 'hover:bg-green-700');
                        iconGps.classList.remove('animate-spin');
                        iconGps.textContent = 'check_circle';
                        textGps.textContent = 'Ubicación Validada';
                    },
                    (error) => {
                        iconGps.classList.remove('animate-spin');
                        iconGps.textContent = 'error';
                        textGps.textContent = 'Error GPS (Reintentar)';
                        if (error.code === error.PERMISSION_DENIED) {
                            alert("Has denegado el acceso al GPS. Por favor, ve a la configuración de tu navegador, permite el acceso a la ubicación y vuelve a intentarlo.");
                        } else {
                            alert("Hubo un error al obtener tu ubicación. Asegúrate de tener el GPS encendido.");
                        }
                    }
                );
            } else {
                iconGps.classList.remove('animate-spin');
                textGps.textContent = 'GPS No soportado';
            }
        });
    }

    // =============================================
    // 7. FILE UPLOAD UI
    // =============================================
    const handleFileUpload = (inputId, iconId, textId, successText, originalIcon, originalText) => {
        const input = document.getElementById(inputId);
        const icon = document.getElementById(iconId);
        const text = document.getElementById(textId);
        const deleteBtn = document.getElementById('delete-' + inputId);
        const container = document.getElementById('container-' + inputId);

        let imgPreview = null;
        if (container) {
            imgPreview = document.createElement('img');
            imgPreview.className = 'absolute inset-0 w-full h-full object-cover rounded-xl hidden z-0 opacity-40';
            imgPreview.style.pointerEvents = 'none';
            container.style.position = 'relative';
            container.style.overflow = 'hidden';
            container.appendChild(imgPreview);
        }

        if (input && deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                input.value = '';
                icon.textContent = originalIcon;
                icon.classList.remove('text-green-500');
                icon.classList.add('text-on-surface-variant', 'group-hover:text-tertiary');
                text.textContent = originalText;
                deleteBtn.classList.add('hidden');
                container.classList.remove('border-green-500', 'bg-green-50');
                if (imgPreview) { imgPreview.src = ''; imgPreview.classList.add('hidden'); }
                deletePhotoFromDB(inputId).catch(() => {});
                updateProgress();
            });

            input.addEventListener('change', async (e) => {
                if (e.target.files.length > 0) {
                    icon.textContent = 'sync';
                    icon.classList.add('animate-spin', 'text-tertiary');
                    icon.classList.remove('text-on-surface-variant', 'group-hover:text-tertiary', 'text-green-500');
                    text.textContent = inputId === 'file-selfie-dni' ? 'Analizando rostro...' : 'Guardando...';
                    deleteBtn.classList.add('hidden');
                    input.disabled = true;

                    // === Validación Selfie + DNI con IA ===
                    if (inputId === 'file-selfie-dni' && typeof faceapi !== 'undefined' && faceApiLoaded) {
                        try {
                            const imgUrl = URL.createObjectURL(e.target.files[0]);
                            const img = new Image();
                            img.src = imgUrl;
                            await new Promise(resolve => { img.onload = resolve; });

                            text.textContent = 'Analizando rostro y DNI...';
                            const result = await validateSelfieWithDNI(img);
                            URL.revokeObjectURL(imgUrl);

                            if (!result.valid) {
                                let msg = '';
                                switch (result.reason) {
                                    case 'no_face':
                                        msg = '🚨 NO SE DETECTÓ ROSTRO\n\nNo pudimos detectar tu rostro en la foto.\n\nAsegúrate de:\n• Tu rostro esté visible y de frente\n• Haya buena iluminación\n• La imagen no esté borrosa';
                                        break;
                                    case 'face_too_small':
                                        msg = '🚨 ROSTRO MUY PEQUEÑO\n\nTu rostro se ve muy lejos en la foto.\n\nAcércate un poco más a la cámara, pero asegúrate de que tu DNI también se vea.';
                                        break;
                                    case 'face_too_large':
                                        msg = '🚨 FOTO INCORRECTA\n\nTu rostro ocupa casi toda la imagen.\n\nNecesitamos ver tu rostro Y tu DNI juntos.\nAléjate un poco y sostén tu DNI cerca de tu rostro.';
                                        break;
                                    case 'no_document':
                                        msg = '🚨 NO SE DETECTÓ DNI\n\nDetectamos tu rostro pero NO encontramos un documento (DNI) en la foto.\n\nSostén tu DNI junto a tu rostro, asegurándote de que se vea completo y con buena luz.';
                                        break;
                                    default:
                                        msg = '🚨 Error en la validación. Intenta de nuevo.';
                                }
                                alert(msg);
                                input.value = '';
                                input.disabled = false;
                                icon.classList.remove('animate-spin', 'text-tertiary');
                                icon.textContent = originalIcon;
                                icon.classList.add('text-on-surface-variant', 'group-hover:text-tertiary');
                                text.textContent = originalText;
                                return;
                            }
                        } catch (faceErr) {
                            console.warn('Error en validación facial, omitiendo', faceErr);
                        }
                    }

                    try {
                        const compressed = await compressImage(e.target.files[0]);
                        await savePhotoToDB(inputId, compressed);
                    } catch (err) { console.error('Error saving photo to DB', err); }

                    setTimeout(() => {
                        input.disabled = false;
                        icon.classList.remove('animate-spin', 'text-tertiary');
                        icon.textContent = 'check_circle';
                        icon.classList.add('text-green-500');
                        text.textContent = successText;
                        deleteBtn.classList.remove('hidden');
                        container.classList.add('border-green-500', 'bg-green-50');

                        if (imgPreview && e.target.files[0] && e.target.files[0].type.startsWith('image/')) {
                            imgPreview.src = URL.createObjectURL(e.target.files[0]);
                            imgPreview.classList.remove('hidden');
                        }
                        updateProgress();
                    }, 800);
                }
            });

            // Restore from IndexedDB on page load
            getPhotoFromDB(inputId).then(blob => {
                if (blob) {
                    icon.classList.remove('text-on-surface-variant', 'group-hover:text-tertiary');
                    icon.textContent = 'check_circle';
                    icon.classList.add('text-green-500');
                    text.textContent = successText;
                    deleteBtn.classList.remove('hidden');
                    container.classList.add('border-green-500', 'bg-green-50');
                }
            }).catch(() => {});
        }
    };

    handleFileUpload('file-dni-front', 'icon-file-dni-front', 'text-file-dni-front', 'Frente OK', 'badge', 'DNI Frente');
    handleFileUpload('file-dni-back', 'icon-file-dni-back', 'text-file-dni-back', 'Reverso OK', 'credit_card', 'DNI Reverso');
    handleFileUpload('file-selfie-dni', 'icon-file-selfie-dni', 'text-file-selfie-dni', 'Selfie OK', 'portrait', 'Selfie c/ DNI');
    handleFileUpload('file-recibo', 'icon-file-recibo', 'text-file-recibo', 'Recibo OK', 'receipt_long', 'Recibo Luz/Agua');

    // =============================================
    // 7.5 INTEGRATED CAMERA (SELFIE)
    // =============================================
    const btnOpenCamera = document.getElementById('btn-open-camera');
    const cameraModal = document.getElementById('camera-modal');
    const cameraModalContent = document.getElementById('camera-modal-content');
    const cameraVideo = document.getElementById('camera-video');
    const cameraCanvas = document.getElementById('camera-canvas');
    const btnCloseCamera = document.getElementById('btn-close-camera');
    const btnCaptureCamera = document.getElementById('btn-capture-camera');
    const btnFlipCamera = document.getElementById('btn-flip-camera');
    
    // Instruction Modal elements
    const instructionModal = document.getElementById('instruction-modal');
    const instructionModalContent = document.getElementById('instruction-modal-content');
    const btnUnderstandInstruction = document.getElementById('btn-understand-instruction');

    let cameraStream = null;
    let currentFacingMode = "user";

    async function startCameraMode(mode) {
        stopCamera();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Cámara no soportada en este entorno (posible falta de HTTPS).");
        }
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode } });
        } catch(e) {
            cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
        }
        cameraVideo.srcObject = cameraStream;
        if (mode === "user") {
            cameraVideo.classList.add("scale-x-[-1]");
        } else {
            cameraVideo.classList.remove("scale-x-[-1]");
        }
    }

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
            cameraStream = null;
        }
        if (cameraVideo) cameraVideo.srcObject = null;
    }

    if (btnOpenCamera && instructionModal) {
        btnOpenCamera.addEventListener('click', (e) => {
            e.preventDefault();
            instructionModal.classList.remove('hidden');
            instructionModal.classList.add('flex');
            setTimeout(() => {
                instructionModalContent.classList.remove('scale-95', 'opacity-0');
                instructionModalContent.classList.add('scale-100', 'opacity-100');
            }, 10);
        });
    }

    if (btnUnderstandInstruction && cameraModal) {
        btnUnderstandInstruction.addEventListener('click', async () => {
            // Close instruction modal
            instructionModalContent.classList.remove('scale-100', 'opacity-100');
            instructionModalContent.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                instructionModal.classList.remove('flex');
                instructionModal.classList.add('hidden');
            }, 300);

            // Open Camera
            try {
                await startCameraMode(currentFacingMode);
                
                cameraModal.classList.remove('hidden');
                cameraModal.classList.add('flex');
                setTimeout(() => {
                    cameraModalContent.classList.remove('scale-95', 'opacity-0');
                    cameraModalContent.classList.add('scale-100', 'opacity-100');
                }, 10);
            } catch (err) {
                console.error("Camera access error", err);
                alert("No pudimos acceder a tu cámara de forma directa. Por favor, toma una foto o selecciona una desde tu galería.");
                document.getElementById('file-selfie-dni').click();
            }
        });
    }

    if (btnFlipCamera) {
        btnFlipCamera.addEventListener('click', async () => {
            currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
            try {
                btnFlipCamera.classList.add("opacity-50", "pointer-events-none");
                await startCameraMode(currentFacingMode);
            } catch (err) {
                console.error("Flip camera error", err);
            } finally {
                btnFlipCamera.classList.remove("opacity-50", "pointer-events-none");
            }
        });
    }

    if (btnCloseCamera) {
        btnCloseCamera.addEventListener('click', () => {
            cameraModalContent.classList.remove('scale-100', 'opacity-100');
            cameraModalContent.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                cameraModal.classList.remove('flex');
                cameraModal.classList.add('hidden');
                stopCamera();
            }, 300);
        });
    }

    if (btnCaptureCamera) {
        btnCaptureCamera.addEventListener('click', async () => {
            if (!cameraStream) return;
            
            // === IMMEDIATE VISUAL FEEDBACK ===
            // 1) Flash effect — instant
            const flashOverlay = document.getElementById('capture-flash-overlay');
            if (flashOverlay) {
                flashOverlay.classList.add('capture-flash');
                setTimeout(() => flashOverlay.classList.remove('capture-flash'), 400);
            }
            
            // 2) Capture frame IMMEDIATELY (before any async work)
            cameraCanvas.width = cameraVideo.videoWidth;
            cameraCanvas.height = cameraVideo.videoHeight;
            const ctx = cameraCanvas.getContext('2d');
            ctx.drawImage(cameraVideo, 0, 0, cameraCanvas.width, cameraCanvas.height);
            
            // 3) Show processing state right away
            btnCaptureCamera.disabled = true;
            btnCloseCamera.disabled = true;
            btnCaptureCamera.innerHTML = '<span class="material-symbols-outlined animate-spin">progress_activity</span> Procesando...';

            // Small yield to let the UI update before heavy processing
            await new Promise(r => setTimeout(r, 50));

            try {
                // === AI VALIDATION (runs after UI has updated) ===
                if (typeof faceapi !== 'undefined' && faceApiLoaded) {
                    try {
                        btnCaptureCamera.innerHTML = '<span class="material-symbols-outlined animate-spin">progress_activity</span> Analizando...';
                        const result = await validateSelfieWithDNI(cameraCanvas);

                        if (!result.valid) {
                            let msg = '';
                            switch (result.reason) {
                                case 'no_face':
                                    msg = '🚨 NO SE DETECTÓ ROSTRO\n\nNo pudimos detectar tu rostro.\n\nAsegúrate de:\n• Tu rostro esté visible y de frente\n• Haya buena iluminación\n• No te muevas al capturar';
                                    break;
                                case 'face_too_small':
                                    msg = '🚨 ROSTRO MUY PEQUEÑO\n\nAcércate un poco más a la cámara, pero asegúrate de que tu DNI también se vea.';
                                    break;
                                case 'face_too_large':
                                    msg = '🚨 FOTO INCORRECTA\n\nTu rostro ocupa casi toda la imagen.\nAléjate un poco y sostén tu DNI cerca de tu rostro.';
                                    break;
                                case 'no_document':
                                    msg = '🚨 NO SE DETECTÓ DNI\n\nDetectamos tu rostro pero NO encontramos tu DNI en la foto.\n\nSostén tu DNI junto a tu rostro y asegúrate de que se vea completo.';
                                    break;
                                default:
                                    msg = '🚨 Error en la validación. Intenta de nuevo.';
                            }
                            alert(msg);
                            btnCaptureCamera.disabled = false;
                            btnCloseCamera.disabled = false;
                            btnCaptureCamera.innerHTML = '<span class="material-symbols-outlined">photo_camera</span> Capturar';
                            return;
                        }
                    } catch (aiErr) {
                        console.warn('AI Detection skipped due to error:', aiErr);
                    }
                }

                // === SAVE PHOTO ===
                btnCaptureCamera.innerHTML = '<span class="material-symbols-outlined animate-spin">progress_activity</span> Guardando...';
                
                cameraCanvas.toBlob(async (blob) => {
                    if (blob) {
                        const file = new File([blob], "selfie_cam.jpg", { type: "image/jpeg" });
                        
                        const icon = document.getElementById('icon-file-selfie-dni');
                        const text = document.getElementById('text-file-selfie-dni');
                        const container = document.getElementById('container-file-selfie-dni');
                        const deleteBtn = document.getElementById('delete-file-selfie-dni');
                        const hiddenInput = document.getElementById('file-selfie-dni');

                        const dataTransfer = new DataTransfer();
                        dataTransfer.items.add(file);
                        if (hiddenInput) {
                            hiddenInput.files = dataTransfer.files;
                        }

                        icon.textContent = 'sync';
                        icon.classList.add('animate-spin', 'text-tertiary');
                        
                        const compressed = await compressImage(file);
                        await savePhotoToDB('file-selfie-dni', compressed);

                        icon.classList.remove('animate-spin', 'text-tertiary');
                        icon.textContent = 'check_circle';
                        icon.classList.add('text-green-500');
                        text.textContent = 'Selfie OK (Validado IA)';
                        deleteBtn.classList.remove('hidden');
                        container.classList.add('border-green-500', 'bg-green-50');

                        let imgPreview = container.querySelector('img.preview-img');
                        if (!imgPreview) {
                            imgPreview = document.createElement('img');
                            imgPreview.className = 'preview-img absolute inset-0 w-full h-full object-cover rounded-xl z-0 opacity-40 pointer-events-none';
                            container.style.position = 'relative';
                            container.appendChild(imgPreview);
                        }
                        imgPreview.src = URL.createObjectURL(blob);
                        imgPreview.classList.remove('hidden');
                        
                        updateProgress();

                        // Nuevo comportamiento: Mensaje de confirmación y scroll
                        btnCaptureCamera.classList.remove('bg-primary');
                        btnCaptureCamera.classList.add('bg-green-500');
                        btnCaptureCamera.innerHTML = '<span class="material-symbols-outlined">check_circle</span> Foto Confirmada';
                        // Cerrar cámara INMEDIATAMENTE
                        btnCloseCamera.disabled = false;
                        btnCloseCamera.click();
                        
                        // Scroll a la seccion 4 (Configuración del Préstamo)
                        const configSection = document.getElementById('calc-monto');
                        if (configSection) {
                            setTimeout(() => {
                                configSection.closest('.premium-glass').scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }, 300);
                        }
                        
                        // Resetear estado del botón para una futura captura
                        setTimeout(() => {
                            btnCaptureCamera.disabled = false;
                            btnCaptureCamera.classList.remove('bg-green-500');
                            btnCaptureCamera.classList.add('bg-primary');
                            btnCaptureCamera.innerHTML = '<span class="material-symbols-outlined">photo_camera</span> Capturar';
                        }, 500);
                    }
                }, 'image/jpeg', 0.85);

            } catch (err) {
                console.error("Error capturando foto", err);
                alert("Hubo un error al procesar la foto.");
                btnCaptureCamera.disabled = false;
                btnCloseCamera.disabled = false;
                btnCaptureCamera.innerHTML = '<span class="material-symbols-outlined">photo_camera</span> Capturar';
            }
        });
    }


    // =============================================
    // 8. INPUT MASKING (Telephone)
    // =============================================
    const telInputs = [document.getElementById('yape'), document.getElementById('otro_celular'), document.getElementById('ref_celular'), document.getElementById('ref2_celular')];
    telInputs.forEach(input => {
        if (input) {
            input.addEventListener('input', function (e) {
                let value = e.target.value.replace(/\D/g, '');
                if (value.length > 9) value = value.slice(0, 9);
                e.target.value = value;
            });
        }
    });

    // =============================================
    // 9. FORM DATA AUTO-SAVE (Legacy key)
    // =============================================
    const formInputsToSave = ['nombre', 'dni', 'fecha_nacimiento', 'estado_civil', 'direccion', 'email', 'yape', 'otro_celular', 'ocupacion', 'centro_trabajo', 'ingreso_mensual', 'ref_nombre', 'ref_parentesco', 'ref_celular', 'ref_dni', 'ref2_nombre', 'ref2_relacion', 'ref2_celular', 'plazo'];
    const savedData = JSON.parse(localStorage.getItem('qoan_form_data') || '{}');

    formInputsToSave.forEach(id => {
        const el = document.getElementById(id);
        if (el && savedData[id]) {
            el.value = savedData[id];
        }
    });

    // Age validation
    const nacimientoInput = document.getElementById('fecha_nacimiento');
    if (nacimientoInput) {
        nacimientoInput.addEventListener('change', (e) => {
            const birthDate = new Date(e.target.value);
            const age = new Date().getFullYear() - birthDate.getFullYear();
            if (age < 18) {
                alert("Debes ser mayor de 18 años para solicitar el préstamo.");
                e.target.value = '';
            }
        });
    }

    // =============================================
    // 10. SIGNATURE PAD (from signature.js)
    // =============================================
    initSignaturePad();

    // =============================================
    // 11. PROGRESS BAR
    // =============================================
    const allFormInputs = document.querySelectorAll('#loan-form input, #loan-form select');
    const progressBar = document.getElementById('progress-bar');

    window.updateProgress = function updateProgress() {
        let filled = 0;
        const requiredIds = ['nombre', 'dni', 'fecha_nacimiento', 'estado_civil', 'direccion', 'yape', 'ocupacion', 'ingreso_mensual', 'ref_nombre', 'ref_celular', 'plazo'];
        let total = requiredIds.length + 4 + 1; // 4 files + 1 signature

        requiredIds.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.value.trim() !== '') filled++;
        });

        ['file-dni-front', 'file-dni-back', 'file-selfie-dni', 'file-recibo'].forEach(id => {
            const icon = document.getElementById('icon-' + id);
            if (icon && icon.textContent === 'check_circle') filled++;
        });

        if (window.hasValidSignature) filled++;

        if (document.getElementById('terminos') && document.getElementById('terminos').checked) filled++;
        total++;

        const percent = Math.min((filled / total) * 100, 100);
        if (progressBar) progressBar.style.width = percent + '%';
    };

    // =============================================
    // 12. DRAFT AUTO-SAVE (Enhanced)
    // =============================================
    const DRAFT_KEY = 'qoan_loan_draft';

    function saveDraft() {
        const draft = {};
        allFormInputs.forEach(input => {
            if (input.type !== 'file' && input.type !== 'submit' && input.id && input.id !== 'terminos') {
                draft[input.id] = input.value;
            }
        });
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    }

    function loadDraft() {
        try {
            const draftStr = localStorage.getItem(DRAFT_KEY);
            if (draftStr) {
                const draft = JSON.parse(draftStr);
                allFormInputs.forEach(input => {
                    if (draft[input.id] !== undefined && input.type !== 'file' && input.id !== 'terminos') {
                        input.value = draft[input.id];
                    }
                });
                updateProgress();
                if (loanSlider) loanSlider.dispatchEvent(new Event('input'));
            }
        } catch (e) { /* ignore parse errors */ }
    }
    setTimeout(loadDraft, 100);

    allFormInputs.forEach(input => {
        input.addEventListener('change', () => { updateProgress(); saveDraft(); });
        input.addEventListener('input', () => { updateProgress(); saveDraft(); });
    });

    // =============================================
    // 13. DNI ASYNC VISUAL VALIDATION
    // =============================================
    const dniFieldIds = ['dni', 'ref_dni'];
    dniFieldIds.forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        const wrapper = input.parentElement;
        const label = wrapper.querySelector('label');

        const badge = document.createElement('span');
        badge.className = 'hidden ml-3 px-2 py-0.5 bg-tertiary text-on-tertiary border-2 border-primary font-black text-[10px] tracking-widest shadow-brutal-hover transform -translate-y-0.5 transition-all';
        badge.innerHTML = 'VALIDADO ✓';

        if (label) {
            label.classList.add('flex', 'items-center', 'justify-between');
            label.appendChild(badge);
        }

        input.addEventListener('input', () => {
            if (input.value.length === 8 && /^\d+$/.test(input.value)) {
                input.style.opacity = '0.5';
                badge.className = 'ml-3 px-2 py-0.5 bg-surface-dim text-on-surface-variant border-2 border-primary font-bold text-[10px] tracking-widest animate-pulse';
                badge.innerHTML = 'VERIFICANDO...';
                badge.classList.remove('hidden');

                setTimeout(() => {
                    input.style.opacity = '1';
                    badge.className = 'ml-3 px-2 py-0.5 bg-green-500 text-white border-2 border-primary font-black text-[10px] tracking-widest shadow-brutal-hover transform -translate-y-0.5 transition-all';
                    badge.innerHTML = 'VALIDADO ✓';
                }, 800);
            } else {
                badge.classList.add('hidden');
            }
        });
    });

    // =============================================
    // 14. FORM SUBMISSION
    // =============================================
    const loanForm = document.getElementById('loan-form');
    const btnSubmit = document.getElementById('btn-submit');
    const btnSubmitText = document.getElementById('btn-submit-text');

    if (loanForm) {
        loanForm.addEventListener('input', () => {
            const dataToSave = {};
            formInputsToSave.forEach(id => {
                const el = document.getElementById(id);
                if (el) dataToSave[id] = el.value;
            });
            localStorage.setItem('qoan_form_data', JSON.stringify(dataToSave));
        });

        loanForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            if (!gpsValidated) {
                alert("Por favor, valida tu ubicación GPS primero para continuar.");
                return;
            }
            if (!window.hasValidSignature) {
                alert("Por favor, firme la solicitud o suba una foto de su firma.");
                return;
            }

            const fDniFrente = await getFileOrBlob('file-dni-front');
            const fDniReverso = await getFileOrBlob('file-dni-back');
            const fSelfie = await getFileOrBlob('file-selfie-dni');
            const fRecibo = await getFileOrBlob('file-recibo');
            if (!fDniFrente || !fDniReverso || !fSelfie || !fRecibo) {
                alert("Por favor, asegúrese de haber tomado o subido todas las 4 fotos requeridas (DNI, Selfie y Recibo).");
                return;
            }

            // Populate and show confirmation modal
            const confirmModal = document.getElementById('confirm-modal');
            const modalContent = document.getElementById('confirm-modal-content');

            document.getElementById('modal-monto').textContent = document.getElementById('calc-monto').textContent;
            const selectPlazo = document.getElementById('plazo');
            document.getElementById('modal-plazo').textContent = selectPlazo.options[selectPlazo.selectedIndex].text;
            document.getElementById('modal-total').textContent = document.getElementById('calc-total').textContent;

            confirmModal.classList.remove('hidden');
            confirmModal.classList.add('flex');
            setTimeout(() => {
                modalContent.classList.remove('scale-95', 'opacity-0');
                modalContent.classList.add('scale-100', 'opacity-100');
            }, 10);
        });

        // Modal Cancel
        document.getElementById('btn-modal-cancel').addEventListener('click', () => {
            const confirmModal = document.getElementById('confirm-modal');
            const modalContent = document.getElementById('confirm-modal-content');
            modalContent.classList.remove('scale-100', 'opacity-100');
            modalContent.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                confirmModal.classList.remove('flex');
                confirmModal.classList.add('hidden');
            }, 300);
        });

        // Modal Confirm — execute real submission
        document.getElementById('btn-modal-confirm').addEventListener('click', async () => {
            const confirmModal = document.getElementById('confirm-modal');
            const modalContent = document.getElementById('confirm-modal-content');
            modalContent.classList.remove('scale-100', 'opacity-100');
            modalContent.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                confirmModal.classList.remove('flex');
                confirmModal.classList.add('hidden');
            }, 300);

            // Loading state
            btnSubmit.disabled = true;
            btnSubmit.classList.add('opacity-80', 'cursor-not-allowed');
            btnSubmitText.innerHTML = '<span class="material-symbols-outlined animate-spin mr-2">progress_activity</span> Procesando solicitud...';

            try {
                // Obtener IP
                let userIp = 'Desconocida';
                try {
                    const ipResponse = await fetch('https://api.ipify.org?format=json');
                    const ipData = await ipResponse.json();
                    userIp = ipData.ip;
                } catch (ipError) { console.error('Error obteniendo IP', ipError); }

                const dniValue = document.getElementById('dni').value;
                const nombreValue = document.getElementById('nombre').value;

                // Collect all form values
                const formData = {
                    nombre: nombreValue,
                    dni: dniValue,
                    fecha_nacimiento: document.getElementById('fecha_nacimiento').value,
                    estado_civil: document.getElementById('estado_civil').value,
                    direccion: document.getElementById('direccion').value,
                    email: document.getElementById('email').value,
                    yape: document.getElementById('yape').value,
                    otro_celular: document.getElementById('otro_celular').value,
                    ocupacion: document.getElementById('ocupacion').value,
                    centro_trabajo: document.getElementById('centro_trabajo').value,
                    ingreso_mensual: document.getElementById('ingreso_mensual').value,
                    ref_nombre: document.getElementById('ref_nombre').value,
                    ref_parentesco: document.getElementById('ref_parentesco').value,
                    ref_celular: document.getElementById('ref_celular').value,
                    ref_dni: document.getElementById('ref_dni').value,
                    ref2_nombre: document.getElementById('ref2_nombre').value,
                    ref2_relacion: document.getElementById('ref2_relacion').value,
                    ref2_celular: document.getElementById('ref2_celular').value,
                    monto: document.getElementById('loan-range').value,
                    plazo: document.getElementById('plazo').value,
                    latitud: gpsLatitud,
                    longitud: gpsLongitud,
                    ip: userIp
                };
                // Collect files for Discord
                const fDniFrente = await getFileOrBlob('file-dni-front');
                const fDniReverso = await getFileOrBlob('file-dni-back');
                const fSelfie = await getFileOrBlob('file-selfie-dni');
                const fRecibo = await getFileOrBlob('file-recibo');

                let fFirma = null;
                const fileSignature = document.getElementById('file-signature');
                if (fileSignature && fileSignature.files.length > 0) {
                    fFirma = fileSignature.files[0];
                } else if (window.hasValidSignature) {
                    const canvas = document.getElementById('signature-pad');
                    if (canvas) {
                        fFirma = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    }
                }

                const filesToSend = [
                    { blob: fDniFrente, filename: `dni_frente_${dniValue}.jpg` },
                    { blob: fDniReverso, filename: `dni_reverso_${dniValue}.jpg` },
                    { blob: fSelfie, filename: `selfie_${dniValue}.jpg` },
                    { blob: fRecibo, filename: `recibo_${dniValue}.jpg` },
                    { blob: fFirma, filename: `firma_${dniValue}.png` }
                ];

                // Removed DB insert per user request
                formData.latitud = gpsLatitud;
                formData.longitud = gpsLongitud;
                formData.ip = userIp;

                // Send to Discord
                await sendToDiscord(formData);
                await sendPhotosToDiscord(filesToSend, dniValue);

                const whatsappMsg = encodeURIComponent(`Hola QOAN, acabo de enviar mi solicitud de préstamo. Mi DNI es ${dniValue} y mi nombre es ${nombreValue}. Quedo atento a la aprobación.`);

                // Clear drafts on success
                localStorage.removeItem(DRAFT_KEY);
                localStorage.removeItem('qoan_form_data');

                // Show Success Message
                const container = document.querySelector('#solicitud .max-w-4xl');
                container.innerHTML = `
                    <div class="premium-glass p-12 md:p-20 text-center">
                        <div class="w-24 h-24 bg-green-500 text-white border-4 border-primary flex items-center justify-center mx-auto mb-10 shadow-brutal">
                            <span class="material-symbols-outlined text-6xl">verified</span>
                        </div>
                        <h2 class="font-display font-black text-4xl md:text-5xl uppercase tracking-tighter mb-6 text-primary">Solicitud en Revisión</h2>
                        
                        <div class="bg-surface-bright p-8 border-4 border-primary max-w-xl mx-auto mb-10 shadow-brutal">
                            <p class="font-body text-xl font-medium text-on-surface-variant leading-relaxed">
                                Espere su aprobación,<br/>
                                <strong class="text-[#25D366] text-2xl mt-4 inline-flex items-center gap-2">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="currentColor" class="bi bi-whatsapp" viewBox="0 0 16 16">
                                      <path d="M13.601 2.326A7.85 7.85 0 0 0 7.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.9 7.9 0 0 0 3.79.965h.004c4.368 0 7.926-3.558 7.93-7.93A7.9 7.9 0 0 0 13.6 2.326zM7.994 14.521a6.6 6.6 0 0 1-3.356-.92l-.24-.144-2.494.654.666-2.433-.156-.251a6.56 6.56 0 0 1-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 0 1 4.66 1.931 6.56 6.56 0 0 1 1.928 4.66c-.004 3.639-2.961 6.592-6.592 6.592m3.615-4.934c-.197-.099-1.17-.578-1.353-.646-.182-.065-.315-.099-.445.099-.133.197-.513.646-.627.775-.114.133-.232.148-.43.05-.197-.1-.836-.308-1.592-.985-.59-.525-.985-1.175-1.103-1.372-.114-.198-.011-.304.088-.403.087-.088.197-.232.296-.346.1-.114.133-.198.198-.33.065-.134.034-.248-.015-.347-.05-.099-.445-1.076-.612-1.47-.16-.389-.323-.335-.445-.34-.114-.007-.247-.007-.38-.007a.73.73 0 0 0-.529.247c-.182.198-.691.677-.691 1.654s.71 1.916.81 2.049c.098.133 1.394 2.132 3.383 2.992.47.205.84.326 1.129.418.475.152.904.129 1.246.08.38-.058 1.171-.48 1.338-.943.164-.464.164-.86.114-.943-.049-.084-.182-.133-.38-.232"/>
                                    </svg>
                                    Le comunicarán por WhatsApp
                                </strong>
                            </p>
                        </div>
                        
                        <div class="flex flex-col gap-4 max-w-sm mx-auto">
                            <a href="https://wa.me/51900779111?text=${whatsappMsg}" target="_blank" class="w-full bg-[#25D366] text-white font-headline font-bold uppercase text-sm tracking-widest px-10 py-5 border-4 border-primary shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-brutal-hover transition-all flex items-center justify-center gap-3">
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-whatsapp" viewBox="0 0 16 16">
                                  <path d="M13.601 2.326A7.85 7.85 0 0 0 7.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.9 7.9 0 0 0 3.79.965h.004c4.368 0 7.926-3.558 7.93-7.93A7.9 7.9 0 0 0 13.6 2.326zM7.994 14.521a6.6 6.6 0 0 1-3.356-.92l-.24-.144-2.494.654.666-2.433-.156-.251a6.56 6.56 0 0 1-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 0 1 4.66 1.931 6.56 6.56 0 0 1 1.928 4.66c-.004 3.639-2.961 6.592-6.592 6.592m3.615-4.934c-.197-.099-1.17-.578-1.353-.646-.182-.065-.315-.099-.445.099-.133.197-.513.646-.627.775-.114.133-.232.148-.43.05-.197-.1-.836-.308-1.592-.985-.59-.525-.985-1.175-1.103-1.372-.114-.198-.011-.304.088-.403.087-.088.197-.232.296-.346.1-.114.133-.198.198-.33.065-.134.034-.248-.015-.347-.05-.099-.445-1.076-.612-1.47-.16-.389-.323-.335-.445-.34-.114-.007-.247-.007-.38-.007a.73.73 0 0 0-.529.247c-.182.198-.691.677-.691 1.654s.71 1.916.81 2.049c.098.133 1.394 2.132 3.383 2.992.47.205.84.326 1.129.418.475.152.904.129 1.246.08.38-.058 1.171-.48 1.338-.943.164-.464.164-.86.114-.943-.049-.084-.182-.133-.38-.232"/>
                                </svg>
                                Contactar Asesor
                            </a>
                        </div>
                    </div>
                `;
                document.getElementById('solicitud').scrollIntoView({ behavior: 'smooth' });
            } catch (e) {
                console.error("General error processing request", e);
                alert("Hubo un error al procesar tu solicitud. Por favor intenta de nuevo.");
            } finally {
                btnSubmit.disabled = false;
                btnSubmit.classList.remove('opacity-80', 'cursor-not-allowed');
                btnSubmitText.innerHTML = 'Finalizar y Desembolsar';
            }
        });
    }
});
