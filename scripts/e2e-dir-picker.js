// 端到端测试用：替换 showDirectoryPicker，把项目文件夹镜像到 dev 宿主的编辑器保存接口。
// 由 verify-editor-headless 在每个新文档注入。页面产品代码只认目录句柄。
(() => {
  const enc = (s) => encodeURIComponent(s);
  const bytesOf = async (data) => {
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    const u = data instanceof Uint8Array ? data : new Uint8Array(data);
    return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u : u.slice();
  };

  function createRoot() {
    const root = {
      kind: "directory",
      name: "project",
      itemId: `editor-e2e${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`,
      begun: false,
      children: new Map(),
    };
    root.name = root.itemId;

    const collect = (dir, prefix, out) => {
      for (const [name, h] of dir.children) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (h.kind === "directory") collect(h, p, out);
        else out.push({ path: p, data: h.data });
      }
      return out;
    };
    const remember = () => {
      const all = JSON.parse(sessionStorage.getItem("wwgl-e2e-projects") || "{}");
      all[root.itemId] = collect(root, "", []).map((f) => f.path);
      sessionStorage.setItem("wwgl-e2e-projects", JSON.stringify(all));
      sessionStorage.setItem("wwgl-e2e-project", root.itemId);
    };
    const postFile = async (path, data) => {
      const res = await fetch(`/api/editor/save-file?item=${enc(root.itemId)}&path=${enc(path)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: data,
      });
      if (!res.ok) throw new Error(await res.text());
    };
    const begin = async () => {
      root.begun = true;
      const res = await fetch(`/api/editor/save-begin?item=${enc(root.itemId)}`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
    };
    const mirrorAll = async () => {
      await begin();
      for (const f of collect(root, "", [])) await postFile(f.path, f.data);
      remember();
    };
    const makeFile = (name, rel, data) => ({
      kind: "file",
      name,
      data,
      async getFile() {
        return new File([this.data], name);
      },
      async createWritable() {
        const chunks = [];
        return {
          write: async (data) => chunks.push(await bytesOf(data)),
          close: async () => {
            const len = chunks.reduce((n, c) => n + c.length, 0);
            const buf = new Uint8Array(len);
            let o = 0;
            for (const c of chunks) {
              buf.set(c, o);
              o += c.length;
            }
            this.data = buf;
            if (!root.begun) await begin();
            await postFile(rel, buf);
            remember();
          },
        };
      },
    });
    const makeDir = (name, prefix) => {
      const dir = {
        kind: "directory",
        name,
        children: new Map(),
        async getDirectoryHandle(child, opts) {
          let h = dir.children.get(child);
          if (!h && opts && opts.create) {
            h = makeDir(child, prefix ? `${prefix}/${child}` : child);
            dir.children.set(child, h);
          }
          if (!h || h.kind !== "directory") throw new Error(`not a directory: ${child}`);
          return h;
        },
        async getFileHandle(child, opts) {
          let h = dir.children.get(child);
          if (!h && opts && opts.create) {
            const rel = prefix ? `${prefix}/${child}` : child;
            h = makeFile(child, rel, new Uint8Array());
            dir.children.set(child, h);
          }
          if (!h || h.kind !== "file") throw new Error(`not a file: ${child}`);
          return h;
        },
        async *entries() {
          for (const pair of dir.children) yield pair;
        },
        async removeEntry(child) {
          dir.children.delete(child);
          await mirrorAll();
        },
      };
      return dir;
    };
    const top = makeDir(root.itemId, "");
    root.children = top.children;
    root.getDirectoryHandle = top.getDirectoryHandle.bind(top);
    root.getFileHandle = top.getFileHandle.bind(top);
    root.entries = top.entries.bind(top);
    root.removeEntry = top.removeEntry.bind(top);
    root.put = (rel, data) => {
      const parts = rel.split("/").filter(Boolean);
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        let next = dir.children.get(seg);
        if (!next) {
          next = makeDir(seg, parts.slice(0, i + 1).join("/"));
          dir.children.set(seg, next);
        }
        dir = next;
      }
      const leaf = parts[parts.length - 1];
      dir.children.set(leaf, makeFile(leaf, rel, data instanceof Uint8Array ? data : new Uint8Array(data)));
    };
    return root;
  }

  window.showDirectoryPicker = async () => {
    const mode = window.__e2eMode || "empty";
    const openId = window.__e2eOpen || null;
    window.__e2eMode = "empty";
    window.__e2eOpen = null;
    const root = createRoot();
    if (mode === "last" || mode === "open") {
      const id = openId || sessionStorage.getItem("wwgl-e2e-project");
      const all = JSON.parse(sessionStorage.getItem("wwgl-e2e-projects") || "{}");
      const paths = (id && all[id]) || [];
      if (id) {
        root.itemId = id;
        root.name = id;
        root.begun = true;
        for (const p of paths) {
          const res = await fetch(`/media/dev/${enc(id)}/${p.split("/").map(enc).join("/")}`);
          if (res.ok) root.put(p, new Uint8Array(await res.arrayBuffer()));
        }
      }
      return root;
    }
    if (mode === "seed" && window.__e2eSeed) {
      const seed = window.__e2eSeed;
      for (const p of seed.paths) {
        const res = await fetch(seed.base + p.split("/").map(enc).join("/"));
        if (res.ok) root.put(p, new Uint8Array(await res.arrayBuffer()));
      }
    }
    sessionStorage.setItem("wwgl-e2e-project", root.itemId);
    return root;
  };
})();
