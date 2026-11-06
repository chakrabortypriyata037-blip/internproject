const form = document.querySelector("#qrForm");
const textInput = document.querySelector("#qrText");
const labelInput = document.querySelector("#label");
const generateBtn = document.querySelector("#generateBtn");
const previewArea = document.querySelector("#previewArea");
const previewActions = document.querySelector("#previewActions");
const downloadCurrent = document.querySelector("#downloadCurrent");
const library = document.querySelector("#library");
const toast = document.querySelector("#toast");
const cloudStatus = document.querySelector(".cloud-status");
const noticeText = document.querySelector(".notice");
const librarySub = document.querySelector(".library-heading p");

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

async function updateStorageBadge() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.storageMode === "s3" && data.bucket) {
      if (cloudStatus) {
        cloudStatus.innerHTML = `<i></i> S3: ${escapeText(data.bucket)}`;
        cloudStatus.title = `AWS S3 Bucket: ${data.bucket} (${data.region})`;
      }
      if (noticeText) {
        noticeText.textContent = `Your QR image is saved in AWS S3 (${data.bucket}).`;
      }
      if (librarySub) {
        librarySub.textContent = `QR codes stored in AWS S3 (${data.bucket})`;
      }
    } else {
      if (cloudStatus) {
        cloudStatus.innerHTML = `<i style="background:#38bdf8;box-shadow:0 0 10px #38bdf8"></i> LOCAL STORAGE`;
        cloudStatus.title = "Running in Local Mode. Add S3_BUCKET_NAME to .env for AWS S3.";
      }
      if (noticeText) {
        noticeText.textContent = "Running in Local Mode. Set S3_BUCKET_NAME in .env to connect AWS S3.";
      }
      if (librarySub) {
        librarySub.textContent = "QR codes stored locally in public/uploads/qrs";
      }
    }
  } catch (err) {
    console.warn("Could not check health:", err);
  }
}

textInput.addEventListener("input", () => {
  document.querySelector("#charCount").textContent = `${textInput.value.length} / 2000`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return notify("Enter some text or a URL first.");

  generateBtn.disabled = true;
  generateBtn.querySelector("span").textContent = "Generating and saving…";

  try {
    const response = await fetch("/api/qr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, label: labelInput.value.trim() })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Something went wrong.");

    const item = data.item;
    previewArea.innerHTML = `<img class="preview-image" src="${item.downloadUrl}" alt="Generated QR Code">`;
    downloadCurrent.href = item.downloadUrl;
    downloadCurrent.download = `${item.label || "qr-code"}.png`;
    previewActions.hidden = false;

    notify(data.message || "QR Code generated successfully.");
    await loadLibrary();
  } catch (error) {
    notify(error.message);
  } finally {
    generateBtn.disabled = false;
    generateBtn.querySelector("span").textContent = "Generate & Save to S3";
  }
});

async function loadLibrary() {
  library.innerHTML = '<div class="library-empty">Loading your cloud library…</div>';
  try {
    const response = await fetch("/api/qr");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load library.");

    if (!data.items || !data.items.length) {
      library.innerHTML = '<div class="library-empty">No QR Codes saved yet. Create your first one above.</div>';
      return;
    }

    library.innerHTML = data.items
      .map((item) => {
        const date = item.lastModified ? new Date(item.lastModified).toLocaleString() : "Recently saved";
        const safeKey = encodeURIComponent(item.key);
        const filename = `${item.label || "qr-code"}.png`;
        return `<article class="library-card">
        <img src="${item.downloadUrl}" alt="QR Code" loading="lazy">
        <div class="card-title" title="${escapeText(item.label)}">${escapeText(item.label || "QR Code")}</div>
        <div class="card-date">${escapeText(date)}</div>
        <div class="card-actions">
          <a href="${item.downloadUrl}" download="${escapeText(filename)}">↓ Download</a>
          <button type="button" data-key="${safeKey}">Delete</button>
        </div>
      </article>`;
      })
      .join("");
  } catch (error) {
    library.innerHTML = `<div class="library-empty">${escapeText(error.message)}</div>`;
  }
}

library.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-key]");
  if (!button) return;
  if (!confirm("Delete this QR Code?")) return;

  button.disabled = true;
  try {
    const key = decodeURIComponent(button.dataset.key);
    const response = await fetch(`/api/qr?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Delete failed.");
    notify(data.message || "QR Code deleted successfully.");
    await loadLibrary();
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
});

document.querySelector("#refreshBtn").addEventListener("click", loadLibrary);

updateStorageBadge();
loadLibrary();
