import "dotenv/config";
import express from "express";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const RAW_BUCKET = (process.env.S3_BUCKET_NAME || "").trim();
const REGION = (process.env.AWS_REGION || "ap-south-1").trim();
const STORAGE_MODE = (process.env.STORAGE_MODE || "auto").trim().toLowerCase();

const isS3Configured =
  STORAGE_MODE !== "local" &&
  Boolean(RAW_BUCKET && RAW_BUCKET !== "replace-with-your-unique-bucket-name");

const BUCKET = isS3Configured ? RAW_BUCKET : "";

// S3 Client configuration:
// 1. If running on EC2: Uses EC2 Instance IAM Role automatically (no keys needed in .env).
// 2. If running locally with keys in .env: Uses those keys.
let s3 = null;
if (isS3Configured) {
  const s3Config = { region: REGION };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3Config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim()
    };
  }
  s3 = new S3Client(s3Config);
}

// Local storage directory for fallback / offline testing
const localUploadsDir = path.join(__dirname, "public", "uploads", "qrs");
if (!fs.existsSync(localUploadsDir)) {
  fs.mkdirSync(localUploadsDir, { recursive: true });
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function safeLabel(value) {
  return (
    String(value || "qr-code")
      .trim()
      .replace(/[^a-zA-Z0-9-_ ]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 40) || "qr-code"
  );
}

function formatAwsError(error) {
  const msg = error?.message || "";
  if (
    error?.name === "CredentialsProviderError" ||
    msg.includes("Could not load credentials from any providers")
  ) {
    return "AWS Credentials পাওয়া যায়নি। আপনি নিজের ল্যাপটপে আছেন—EC2 IAM Role শুধু EC2 ইনস্ট্যান্সের ভেতরে কাজ করে। ল্যাপটপে টেস্ট করার জন্য .env ফাইলে S3_BUCKET_NAME ফাঁকা রাখুন (Local Mode), অথবা AWS Keys দিন।";
  }
  if (error?.name === "NoSuchBucket") {
    return `Bucket "${BUCKET}" পাওয়া যায়নি। AWS Console-এ বাকেটটি তৈরি করে সঠিক নাম .env-এ দিন।`;
  }
  if (error?.name === "AccessDenied") {
    return `Bucket "${BUCKET}"-এ অ্যাক্সেস নেই। EC2 IAM Role বা পারমিশন চেক করুন।`;
  }
  return msg || "Something went wrong.";
}

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "QR Studio",
    storageMode: isS3Configured ? "s3" : "local",
    bucket: BUCKET || null,
    region: REGION
  });
});

// Create a QR PNG and save it in S3 or local storage
app.post("/api/qr", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    const label = safeLabel(req.body?.label);

    if (!text) return res.status(400).json({ error: "Enter text or a URL first." });
    if (text.length > 2000) return res.status(400).json({ error: "Maximum input length is 2,000 characters." });

    const pngBuffer = await QRCode.toBuffer(text, {
      type: "png",
      width: 640,
      margin: 2,
      errorCorrectionLevel: "M"
    });

    if (isS3Configured && s3) {
      const key = `qrs/${Date.now()}-${randomUUID()}-${label}.png`;

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: pngBuffer,
          ContentType: "image/png",
          CacheControl: "private, max-age=0, no-cache"
        })
      );

      const downloadUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${label}.png"`
        }),
        { expiresIn: 900 }
      );

      return res.status(201).json({
        message: "QR Code generated and saved to AWS S3.",
        storageMode: "s3",
        item: { key, label, createdAt: new Date().toISOString(), downloadUrl }
      });
    } else {
      // Local storage mode
      const filename = `${Date.now()}-${randomUUID()}-${label}.png`;
      const filePath = path.join(localUploadsDir, filename);
      await fs.promises.writeFile(filePath, pngBuffer);

      const downloadUrl = `/uploads/qrs/${filename}`;
      const key = `local/${filename}`;

      return res.status(201).json({
        message: "QR Code generated and saved locally.",
        storageMode: "local",
        item: { key, label, createdAt: new Date().toISOString(), downloadUrl }
      });
    }
  } catch (error) {
    console.error("QR create error:", error);
    res.status(500).json({ error: formatAwsError(error) });
  }
});

// List QR images stored in S3 or local storage
app.get("/api/qr", async (_req, res) => {
  try {
    if (isS3Configured && s3) {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: "qrs/",
          MaxKeys: 100
        })
      );

      const validObjects = (result.Contents || []).filter(
        (obj) => obj.Key && obj.Key.endsWith(".png") && (obj.Size ?? 0) > 0
      );

      const items = await Promise.all(
        validObjects.map(async (object) => {
          const key = object.Key;
          const filename = key.split("/").pop() || "qr-code.png";
          const label = filename
            .replace(/^\d+-[0-9a-f-]+-/i, "")
            .replace(/\.png$/i, "")
            .replace(/-/g, " ");
          const downloadUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: BUCKET,
              Key: key,
              ResponseContentDisposition: `attachment; filename="${filename}"`
            }),
            { expiresIn: 900 }
          );

          return {
            key,
            label,
            lastModified: object.LastModified,
            size: object.Size,
            downloadUrl
          };
        })
      );

      items.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
      return res.json({ items, storageMode: "s3", bucket: BUCKET });
    } else {
      // Local storage mode
      if (!fs.existsSync(localUploadsDir)) {
        return res.json({ items: [], storageMode: "local" });
      }

      const files = await fs.promises.readdir(localUploadsDir);
      const items = [];

      for (const filename of files) {
        if (!filename.endsWith(".png")) continue;
        const filePath = path.join(localUploadsDir, filename);
        const stat = await fs.promises.stat(filePath);
        const label = filename
          .replace(/^\d+-[0-9a-f-]+-/i, "")
          .replace(/\.png$/i, "")
          .replace(/-/g, " ");
        items.push({
          key: `local/${filename}`,
          label,
          lastModified: stat.mtime.toISOString(),
          size: stat.size,
          downloadUrl: `/uploads/qrs/${filename}`
        });
      }

      items.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
      return res.json({ items, storageMode: "local" });
    }
  } catch (error) {
    console.error("QR list error:", error);
    res.status(500).json({ error: formatAwsError(error), items: [] });
  }
});

// Delete an object from S3 or local storage
app.delete("/api/qr", async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (!key || key.includes("..")) {
      return res.status(400).json({ error: "Invalid QR Code key." });
    }

    if (key.startsWith("local/")) {
      const filename = path.basename(key);
      const filePath = path.join(localUploadsDir, filename);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      return res.json({ message: "QR Code deleted from local storage." });
    }

    if (key.startsWith("qrs/")) {
      if (!isS3Configured || !s3) {
        return res.status(400).json({ error: "S3 is not configured to delete this item." });
      }
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      return res.json({ message: "QR Code deleted from S3." });
    }

    return res.status(400).json({ error: "Invalid QR Code key format." });
  } catch (error) {
    console.error("QR delete error:", error);
    res.status(500).json({ error: formatAwsError(error) });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================================");
  console.log(`  🚀 QR Studio running on http://localhost:${PORT}`);
  if (isS3Configured) {
    console.log(`  ☁️ Cloud Storage: AWS S3 (Bucket: ${BUCKET}, Region: ${REGION})`);
    console.log("  🔐 Auth: EC2 IAM Role / Environment credentials");
  } else {
    console.log("  📁 Storage Mode: Local Storage (public/uploads/qrs)");
    console.log("  💡 On EC2, set S3_BUCKET_NAME in .env to use the attached IAM role.");
  }
  console.log("==================================================");
});
