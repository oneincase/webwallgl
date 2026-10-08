/**
 * 编辑器外部插件目录（PLUGIN-ARCHITECTURE §5.2）：给 /api/plugins 用。
 *
 * 根目录 = ~/.webwallgl/plugins，外加环境变量 WWGL_PLUGIN_DIRS（按系统路径分隔符分开）；
 * 根下每个含 wwgl-plugin.json 的子目录是一个插件（同名先到先得）。
 * 版本戳 = 文件数 + 最新 mtime：编辑器轮询到戳变化就热重载该插件。
 * 只读、只在这些根之内：文件请求做路径归一与越界拒绝，跳过点文件 / node_modules，单包有文件数和体积上限。
 */
import { promises as fs } from "node:fs";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const MANIFEST = "wwgl-plugin.json";
const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;

export function pluginRoots(env = process.env): string[] {
  const extra = (env.WWGL_PLUGIN_DIRS ?? "").split(delimiter).filter(Boolean);
  return [join(homedir(), ".webwallgl", "plugins"), ...extra].map((p) => resolve(p));
}

type Walked = { files: string[]; bytes: number; mtime: number };

async function walk(dir: string, base = dir, acc: Walked = { files: [], bytes: 0, mtime: 0 }): Promise<Walked> {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, acc);
    else if (e.isFile()) {
      if (acc.files.length >= MAX_FILES) throw new Error(`插件文件超过 ${MAX_FILES} 个：${base}`);
      const st = await fs.stat(full);
      acc.bytes += st.size;
      if (acc.bytes > MAX_BYTES) throw new Error(`插件体积超过 ${MAX_BYTES >> 20} MB：${base}`);
      acc.mtime = Math.max(acc.mtime, st.mtimeMs);
      acc.files.push(relative(base, full).split(sep).join("/"));
    }
  }
  return acc;
}

export type PluginDirEntry = { dir: string; stamp: string; files: string[]; error?: string };

/** 列出全部插件目录（dir = 目录名，同名先到先得） */
export async function listPluginDirs(roots = pluginRoots()): Promise<{ roots: string[]; plugins: PluginDirEntry[] }> {
  const out: PluginDirEntry[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let ents;
    try {
      ents = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith(".") || seen.has(e.name)) continue;
      const dir = join(root, e.name);
      try {
        await fs.access(join(dir, MANIFEST));
      } catch {
        continue;
      }
      seen.add(e.name);
      try {
        const w = await walk(dir);
        out.push({ dir: e.name, stamp: `${w.files.length}:${Math.floor(w.mtime)}`, files: w.files.sort() });
      } catch (err) {
        out.push({ dir: e.name, stamp: "error", files: [], error: (err as Error).message });
      }
    }
  }
  return { roots, plugins: out };
}

/** 插件目录名 → 绝对路径（按根顺序找第一个） */
async function dirOf(name: string, roots: string[]): Promise<string | null> {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) return null;
  for (const root of roots) {
    const d = join(root, name);
    try {
      await fs.access(join(d, MANIFEST));
      return d;
    } catch {
      /* 下一个根 */
    }
  }
  return null;
}

/** 读插件里的一个文件；越界 / 点文件 / 不存在返回 null */
export async function readPluginFile(name: string, path: string, roots = pluginRoots()): Promise<Buffer | null> {
  const d = await dirOf(name, roots);
  if (!d) return null;
  const parts = path.replace(/\\/g, "/").split("/");
  if (!path || parts.some((p) => !p || p === ".." || p.startsWith("."))) return null;
  const full = resolve(d, ...parts);
  if (full !== d && !full.startsWith(d + sep)) return null;
  try {
    return await fs.readFile(full);
  } catch {
    return null;
  }
}
