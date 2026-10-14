// 端到端测试用：替换 showDirectoryPicker，把项目文件夹镜像到 dev 宿主的编辑器保存接口。
// 由 verify-editor-headless 在每个新文档注入。页面产品代码只认目录句柄。
(() => {
  const enc = (s) => encodeURIComponent(s);
  const bytesOf = async (data) => {
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    const u = data instanceof Uint8Array ? data : new Uint8Array(data);
    return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u : u.slice();
  };

  // 会话内 itemId 唯一化：每次页面载入一个 run 前缀 + 单调计数。
  // 原来是 `editor-e2e${random8}`，随机 id 有概率撞上一轮跑剩的目录，而宿主对
  // 「存在但没有编辑标记」的目录一律 409 拒绝（host/wallpaper-host.ts:1098-1103）。
  const RUN_TAG = `${Math.random().toString(36).slice(2, 6)}${Date.now().toString(36)}`;
  let idSeq = 0;
  const freshItemId = () => `editor-e2e${RUN_TAG}${(idSeq++).toString(36)}`;

  function createRoot(seedId) {
    const root = {
      kind: "directory",
      name: "project",
      itemId: seedId || freshItemId(),
      begun: false,
      retries: 0,
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

    // 宿主写请求串行化：同一 root 上的 save-begin / save-file 严格 FIFO、单条在飞。
    // 页面会「不 await 地」探活：editor/main.ts 的 adoptProject() 调 probeDirWritable()（= void probeWritable(...).then(...)），
    // 探针 write→close 触发 save-begin，紧接着 removeEntry→mirrorAll 又无条件发第二条 save-begin；
    // 而 flushAutosave() 的写盘同一时刻也在 postFile。不串行时，宿主的守卫会在它自己
    // rm→mkdir→写编辑标记（host/wallpaper-host.ts:1106-1108）的中间态被同 id 的 save-file 看见
    // （exists && !marked ⇒ 409「目标不是编辑器创建的目录，拒绝覆盖」，或 rm 与 mkdir 之间 ⇒ 409「先调 save-begin」），
    // 于是一次 flush 整个失败：现场就是「保存到项目文件夹后少 project.json」+ 一条 保存失败。
    let ioChain = Promise.resolve();
    const hostSeq = (fn) => {
      const next = ioChain.then(fn, fn);
      ioChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    const noteConflict = (url, status, text) => {
      const all = window.__e2eConflicts || (window.__e2eConflicts = []);
      if (all.length < 20) all.push({ url, status, body: String(text).slice(0, 300) });
    };
    // 每个 itemId 的宿主 I/O 账本（task-22）：真因「flushAutosave 算出 changed=[] ⇒ 真目录一次写请求都没有」
    // 在页面外面看不见，只能靠这张表把「哪个目录收到过哪几个文件」摆到失败现场里（harness saveToLocal 会打印）。
    const noteIo = (kind, path = "", bytes = 0) => {
      const all = window.__e2eIo || (window.__e2eIo = {});
      const rec = all[root.itemId] || (all[root.itemId] = { begin: 0, file: 0, failed: 0, bytes: 0, paths: [] });
      rec[kind]++;
      if (kind === "file") {
        rec.bytes += bytes || 0;
        if (path && rec.paths.length < 40 && rec.paths.indexOf(path) < 0) rec.paths.push(path);
      }
      return rec;
    };
    const postFile = (path, data) =>
      hostSeq(async () => {
        const url = `/api/editor/save-file?item=${enc(root.itemId)}&path=${enc(path)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: data,
        });
        if (!res.ok) {
          const text = await res.text();
          noteIo("failed", path);
          if (res.status === 409) noteConflict(url, res.status, text);
          throw new Error(text);
        }
        noteIo("file", path, data?.length || data?.byteLength || 0);
      });
    let beginInFlight = null;
    const beginOnce = () =>
      hostSeq(async () => {
        const url = `/api/editor/save-begin?item=${enc(root.itemId)}`;
        const res = await fetch(url, { method: "POST" });
        noteIo("begin");
        if (!res.ok) {
          const text = await res.text();
          if (res.status === 409) noteConflict(url, res.status, text);
          return { res, text };
        }
        return { res, text: "" };
      });
    // 单飞：同一 root 绝不同时发两条 save-begin（页面探针与写盘会并发调进来）。
    const begin = () => {
      if (beginInFlight) return beginInFlight;
      beginInFlight = (async () => {
        const first = await beginOnce();
        if (first.res.ok) {
          // 只有请求真的成功，目录才算「已就绪」——原来在 await 之前就置 true，
          // 一次 409 之后所有 close() 里的 `if (!root.begun)` 都跳过 begin，写盘全部级联失败
          // （现场：2 处失败 + 2 处级联，而不是单点）。
          root.begun = true;
          return;
        }
        if (first.res.status !== 409) throw new Error(first.text);
        // 409 = 同 id 的另一条 save-begin 正在 rm/mkdir（守卫求值在写标记之前），或目录是上一轮的残渣。
        // 换一个全新 id 重试一次，把当前整棵树重新镜像过去（否则先写过的文件留在被弃用的旧目录里），
        // 并留下重试证据供 harness 现场输出。
        const from = root.itemId;
        root.itemId = freshItemId();
        root.name = root.itemId;
        root.retries++;
        const retries = window.__e2eRetries || (window.__e2eRetries = []);
        retries.push({ from, to: root.itemId, status: first.res.status, body: first.text.slice(0, 200) });
        remember();
        const second = await beginOnce();
        if (!second.res.ok) throw new Error(second.text);
        root.begun = true;
        for (const f of collect(root, "", [])) await postFile(f.path, f.data);
      })().finally(() => {
        beginInFlight = null;
      });
      return beginInFlight;
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
          noteIo("removed", child);
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
    const root = createRoot(mode === "last" || mode === "open" ? openId || sessionStorage.getItem("wwgl-e2e-project") : null);
    if (mode === "last" || mode === "open") {
      const id = root.itemId;
      const all = JSON.parse(sessionStorage.getItem("wwgl-e2e-projects") || "{}");
      const paths = (id && all[id]) || [];
      if (id) {
        // 已存在的工程目录：宿主那边已经写好标记，直接沿用（不能再发 save-begin，那会 rm 掉它）。
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
