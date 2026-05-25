import fs from "node:fs/promises";
import path from "node:path";

const DIRECTIVE_PATTERN = /```connectting-dl\s*([\s\S]*?)```/g;

export function parseReplyPackage(rawReply, workDir) {
  const rawText = String(rawReply ?? "");
  const matches = [...rawText.matchAll(DIRECTIVE_PATTERN)];
  if (!matches.length) {
    return {
      visibleText: rawText.trim(),
      attachments: [],
      rawText
    };
  }

  const lastMatch = matches[matches.length - 1];
  let directive = {};
  try {
    directive = JSON.parse(lastMatch[1].trim());
  } catch (error) {
    throw new Error(`Invalid connectting-dl attachment directive: ${error instanceof Error ? error.message : String(error)}`);
  }

  const visibleText = `${rawText.slice(0, lastMatch.index)}${rawText.slice(lastMatch.index + lastMatch[0].length)}`.trim();
  const attachments = normalizeAttachments(directive.attachments ?? [], workDir);
  return {
    visibleText,
    attachments,
    rawText
  };
}

function normalizeAttachments(items, workDir) {
  if (!Array.isArray(items)) {
    throw new Error("attachments must be an array");
  }
  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`attachment[${index}] must be an object`);
    }
    if (!item.path || typeof item.path !== "string") {
      throw new Error(`attachment[${index}].path is required`);
    }
    const resolvedPath = path.isAbsolute(item.path) ? item.path : path.resolve(workDir, item.path);
    const type = normalizeAttachmentType(item.type, resolvedPath);
    return {
      type,
      path: item.path,
      resolvedPath,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : path.basename(resolvedPath)
    };
  });
}

function normalizeAttachmentType(type, filePath) {
  if (type === "image" || type === "file") {
    return type;
  }
  return isImagePath(filePath) ? "image" : "file";
}

export function isImagePath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension);
}

export async function validateReplyPackage(replyPackage) {
  for (const attachment of replyPackage.attachments) {
    await fs.access(attachment.resolvedPath);
  }
}
