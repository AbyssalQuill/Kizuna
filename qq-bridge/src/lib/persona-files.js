import fs from "node:fs";
import path from "node:path";

const PERSONAS_REL_DIR = path.join("state", "personas");
const META_FILE_NAME = "_meta.json";

export function sanitizePersonaId(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || `persona-${Date.now().toString(36)}`;
}

function getPersonasDir(rootDir) {
  return path.join(rootDir, PERSONAS_REL_DIR);
}

function readMeta(dir) {
  const metaPath = path.join(dir, META_FILE_NAME);
  try {
    if (fs.existsSync(metaPath)) {
      const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* ignore */
  }
  return { activeId: "", names: {}, updatedAt: {} };
}

function writeMeta(dir, meta) {
  const metaPath = path.join(dir, META_FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

function extractTitleFromMarkdown(content, fallbackId) {
  const text = String(content || "");
  if (/小鲸鱼|大肥鱼|deepseek/i.test(text.slice(0, 500))) {
    return "小鲸鱼（大肥鱼）";
  }
  const firstHeading = text.match(/^#\s+(.+)$/m);
  if (firstHeading && firstHeading[1]) {
    const h = firstHeading[1].replace(/---/g, "").replace(/\[[^\]]+\]/g, "").trim();
    if (h) return h.slice(0, 32);
  }
  return fallbackId;
}

export function ensurePersonasSeeded(rootDir) {
  const dir = getPersonasDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta(dir);
  if (!meta.names || typeof meta.names !== "object") meta.names = {};
  if (!meta.updatedAt || typeof meta.updatedAt !== "object") meta.updatedAt = {};

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"));

  const mainPersonaPath = path.join(rootDir, "persona.md");
  const examplePersonaPath = path.join(rootDir, "persona.example.md");
  if (!fs.existsSync(mainPersonaPath) && fs.existsSync(examplePersonaPath)) {
    try {
      fs.copyFileSync(examplePersonaPath, mainPersonaPath);
    } catch {
      /* ignore */
    }
  }
  const mainContent = fs.existsSync(mainPersonaPath)
    ? fs.readFileSync(mainPersonaPath, "utf8")
    : "";

  if (files.length === 0 && mainContent.trim()) {
    const seedId = "deepseek-whale";
    const seedFile = path.join(dir, `${seedId}.md`);
    fs.writeFileSync(seedFile, mainContent, "utf8");
    meta.activeId = seedId;
    meta.names[seedId] = extractTitleFromMarkdown(mainContent, "默认人设");
    meta.updatedAt[seedId] = Date.now();
    writeMeta(dir, meta);
  } else if (files.length > 0 && !meta.activeId) {
    const firstId = files[0].name.replace(/\.md$/i, "");
    meta.activeId = firstId;
    writeMeta(dir, meta);
  }
  return { dir, meta };
}

export function listPersonaFiles(rootDir) {
  const { dir, meta } = ensurePersonasSeeded(rootDir);
  const mainPersonaPath = path.join(rootDir, "persona.md");
  const currentMain = fs.existsSync(mainPersonaPath)
    ? fs.readFileSync(mainPersonaPath, "utf8")
    : "";

  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => {
      const id = d.name.replace(/\.md$/i, "");
      const fullPath = path.join(dir, d.name);
      let content = "";
      let mtimeMs = 0;
      try {
        content = fs.readFileSync(fullPath, "utf8");
        mtimeMs = fs.statSync(fullPath).mtimeMs || 0;
      } catch {
        /* ignore */
      }
      const name = meta.names?.[id] || extractTitleFromMarkdown(content, id);
      const preview = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .slice(0, 2)
        .join(" ")
        .slice(0, 90);
      const active =
        meta.activeId === id ||
        (Boolean(currentMain.trim()) && content.trim() === currentMain.trim());
      return {
        id,
        name,
        active,
        chars: content.length,
        preview,
        content,
        updatedAt: meta.updatedAt?.[id] || Math.round(mtimeMs),
      };
    });

  entries.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  return {
    activeId: meta.activeId || entries.find((e) => e.active)?.id || "",
    items: entries,
  };
}

export function resolvePersonaEntry(rootDir, idOrName) {
  const q = String(idOrName || "").trim();
  if (!q) return null;
  const { items } = listPersonaFiles(rootDir);
  const exactId = items.find((x) => x.id.toLowerCase() === q.toLowerCase());
  if (exactId) return exactId;
  const exactName = items.find((x) => x.name.toLowerCase() === q.toLowerCase());
  if (exactName) return exactName;
  const slug = sanitizePersonaId(q);
  const slugMatch = items.find((x) => x.id.toLowerCase() === slug.toLowerCase());
  if (slugMatch) return slugMatch;
  const fuzzy = items.find(
    (x) =>
      x.name.toLowerCase().includes(q.toLowerCase()) ||
      x.id.toLowerCase().includes(q.toLowerCase()),
  );
  return fuzzy || null;
}

export function savePersonaFile(rootDir, { id, name, content, activate = false } = {}) {
  const { dir, meta } = ensurePersonasSeeded(rootDir);
  const label = String(name || id || "未命名人设").trim().slice(0, 40);
  const finalId = sanitizePersonaId(id || label);
  const body = String(content ?? "");
  const filePath = path.join(dir, `${finalId}.md`);
  fs.writeFileSync(filePath, body, "utf8");

  meta.names[finalId] = label;
  meta.updatedAt[finalId] = Date.now();
  if (activate || !meta.activeId) {
    meta.activeId = finalId;
    const mainPersonaPath = path.join(rootDir, "persona.md");
    if (fs.existsSync(mainPersonaPath)) {
      try {
        fs.copyFileSync(mainPersonaPath, path.join(rootDir, "persona.backup-prev.md"));
      } catch {
        /* ignore */
      }
    }
    fs.writeFileSync(mainPersonaPath, body, "utf8");
  }
  writeMeta(dir, meta);
  return {
    ok: true,
    id: finalId,
    name: label,
    activeId: meta.activeId,
    ...listPersonaFiles(rootDir),
  };
}

export function activatePersonaFile(rootDir, idOrName) {
  const { dir, meta } = ensurePersonasSeeded(rootDir);
  const target = resolvePersonaEntry(rootDir, idOrName);
  if (!target) {
    return { ok: false, error: `未找到名为「${idOrName}」的单文件人设` };
  }
  const mainPersonaPath = path.join(rootDir, "persona.md");
  if (fs.existsSync(mainPersonaPath)) {
    try {
      fs.copyFileSync(mainPersonaPath, path.join(rootDir, "persona.backup-prev.md"));
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(mainPersonaPath, target.content, "utf8");
  meta.activeId = target.id;
  meta.updatedAt[target.id] = Date.now();
  writeMeta(dir, meta);
  return {
    ok: true,
    id: target.id,
    name: target.name,
    content: target.content,
    ...listPersonaFiles(rootDir),
  };
}

export function deletePersonaFile(rootDir, idOrName) {
  const { dir, meta } = ensurePersonasSeeded(rootDir);
  const target = resolvePersonaEntry(rootDir, idOrName);
  if (!target) {
    return { ok: false, error: `未找到名为「${idOrName}」的单文件人设` };
  }
  const filePath = path.join(dir, `${target.id}.md`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  delete meta.names[target.id];
  delete meta.updatedAt[target.id];
  if (meta.activeId === target.id) {
    const remaining = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"));
    meta.activeId = remaining.length > 0 ? remaining[0].name.replace(/\.md$/i, "") : "";
  }
  writeMeta(dir, meta);
  return {
    ok: true,
    deletedId: target.id,
    deletedName: target.name,
    ...listPersonaFiles(rootDir),
  };
}
