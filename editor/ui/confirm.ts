// 自定义确认框：替代 window.confirm（原生弹窗在深色界面里像外来户，也没法标出「危险」）。
//
// 用原生 <dialog> + showModal()：顶层渲染、焦点陷阱、Esc 关闭都由浏览器保证；
// 「危险」操作的初始焦点落在「取消」上，所以顺手按回车不会误删东西。
// 文字一律走 textContent（调用方可能把条目名塞进文案，避免拼接 HTML）。
import { et } from "../i18n";

export type ConfirmSpec = {
  /** 标题：一句话说清要发生什么（「删除这张壁纸？」） */
  title: string;
  /** 正文：后果与细节；支持换行 */
  body?: string;
  /** 附带说明：最高优先级的警告（如插件申请的敏感能力），斜体小字 */
  note?: string;
  /** 主按钮文案，默认「确认」 */
  ok?: string;
  /** 次按钮文案，默认「取消」 */
  cancel?: string;
  /** 破坏性操作：主按钮变红，初始焦点给「取消」 */
  danger?: boolean;
};

const ICON_INFO = "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8m0 3.1v.2m0 2.1v4.2";
const ICON_WARN = "M8 2.4 14.6 13H1.4zM8 6.3v3.4m0 1.9v.2";

let dlg: HTMLDialogElement | null = null;
let els: {
  card: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  note: HTMLElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
  icon: SVGPathElement;
} | null = null;
let settle: ((ok: boolean) => void) | null = null;
let accepted = false;
/** 当前这次询问是不是破坏性操作（回车键的处理要用，见下面的 keydown） */
let dangerRef = false;
let lastFocus: HTMLElement | null = null;

function svgIcon(d: string): { svg: SVGSVGElement; path: SVGPathElement } {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "i i-sm");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return { svg, path };
}

function build(): NonNullable<typeof els> {
  const root = document.createElement("dialog");
  root.className = "ed-confirm";
  // alertdialog：读屏会把它当成需要立刻回应的询问（普通 dialog 只是「一个对话框」）
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-labelledby", "ed-confirm-title");
  root.setAttribute("aria-describedby", "ed-confirm-body");

  const card = document.createElement("div");
  card.className = "ed-confirm-card";

  const head = document.createElement("div");
  head.className = "ed-confirm-head";
  const badge = document.createElement("span");
  badge.className = "ed-confirm-badge";
  badge.setAttribute("aria-hidden", "true");
  const { svg, path } = svgIcon(ICON_INFO);
  badge.appendChild(svg);

  const text = document.createElement("div");
  text.className = "ed-confirm-text";
  const title = document.createElement("h2");
  title.className = "ed-confirm-title";
  title.id = "ed-confirm-title";
  const body = document.createElement("p");
  body.className = "ed-confirm-body";
  body.id = "ed-confirm-body";
  text.append(title, body);
  head.append(badge, text);

  const note = document.createElement("p");
  note.className = "ed-confirm-note";

  const actions = document.createElement("div");
  actions.className = "ed-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ed-btn ed-confirm-cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "ed-btn is-primary ed-confirm-ok";
  actions.append(cancel, ok);

  card.append(head, note, actions);
  root.appendChild(card);
  document.body.appendChild(root);

  // 点卡片外面 = 取消（点卡片内部不会冒泡到这里当成取消）
  root.addEventListener("click", (e) => {
    if (e.target === root) close(false);
  });
  // Esc：浏览器会先派发 cancel，再关闭对话框
  root.addEventListener("cancel", () => {
    accepted = false;
  });
  // 回车：自己派发，别指望浏览器的「按钮默认激活」——编辑器里有别的 window 级 keydown，
  // 一旦有人 preventDefault，聚焦按钮上的回车就静默失效（实测过）。这里捕获阶段直接接管：
  // 危险操作的回车落在「取消」（初始焦点也在取消），其余落在确定。
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      (dangerRef ? cancel : ok).click();
    },
    true,
  );
  root.addEventListener("close", () => {
    const done = settle;
    settle = null;
    const back = lastFocus;
    lastFocus = null;
    if (back && document.contains(back)) back.focus();
    if (done) done(accepted);
  });
  ok.addEventListener("click", () => close(true));
  cancel.addEventListener("click", () => close(false));

  dlg = root;
  return (els = { card, title, body, note, ok, cancel, icon: path });
}

function close(ok: boolean) {
  accepted = ok;
  dlg?.close();
}

/** 弹出确认框；resolve true = 用户确认。同一时刻只会有一个，重复调用会把上一个当取消。 */
export function confirmDialog(spec: ConfirmSpec): Promise<boolean> {
  const e = els ?? build();
  if (settle) {
    const prev = settle;
    settle = null;
    prev(false);
  }
  const danger = !!spec.danger;
  dangerRef = danger;
  lastFocus = (document.activeElement as HTMLElement | null) ?? null;
  e.card.classList.toggle("is-danger", danger);
  e.icon.setAttribute("d", danger ? ICON_WARN : ICON_INFO);
  e.title.textContent = spec.title;
  e.body.textContent = spec.body ?? "";
  e.body.hidden = !spec.body;
  e.note.textContent = spec.note ?? "";
  e.note.hidden = !spec.note;
  e.ok.textContent = spec.ok ?? et("confirm.ok");
  e.cancel.textContent = spec.cancel ?? et("confirm.cancel");
  e.ok.classList.toggle("is-danger", danger);
  e.ok.classList.toggle("is-primary", !danger);
  accepted = false;
  const done = new Promise<boolean>((res) => {
    settle = res;
  });
  // 已经开着就复用（重复调用时上面已把上一次当取消）；再 showModal() 会抛 InvalidStateError
  if (!dlg!.open) dlg!.showModal();
  // 危险操作先聚焦「取消」：回车/空格落到安全的一边
  (danger ? e.cancel : e.ok).focus();
  return done;
}
