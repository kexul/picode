// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  // 是否运行在网页服务的页面里（browserBridge.js 会先于本文件设这个标记）。
  // 网页端与 VSCode 共用这份脚本，少数行为按此区分：edit/write 卡片默认收起等。
  // 供扩展宿主选择“最后活动的 Pi Chat”；pointerdown 覆盖大多数 webview
  // 内部交互，focus 覆盖 Ctrl+Tab / 编辑器组切换后的焦点恢复。
  const notifyHostFocus = () => vscode.postMessage({ type: "hostFocus" });
  window.addEventListener("focus", notifyHostFocus);
  document.addEventListener("pointerdown", notifyHostFocus, { capture: true });
  // 第一次用户交互时把音频上下文提前建好并恢复，避免后面“跑完了却不响”。
  document.addEventListener("pointerdown", function warmOnce() { warmUpAudio(); }, { capture: true, once: true });
  const messagesEl = document.getElementById("messages"); // 容器，内含各 .tab-pane
  const jumpBottomBtn = document.getElementById("jumpBottom");
  const stopBtn = document.getElementById("stopBtn"); // 停止生成图标：browserBridge.js 在两种页面里都会创建
  // VSCode 官方 codicon 的 chevron-right 折线图标（从 @vscode/codicons 包取出）。
  // 各处折叠小三角用同一份：画的是朝右，展开时靠 CSS transform 转成朝下。
  const CHEVRON_SVG =
    '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">' +
    '<path d="M6.14601 3.14579C5.95101 3.34079 5.95101 3.65779 6.14601 3.85279L10.292 7.99879L6.14601 12.1448C5.95101 12.3398 5.95101 12.6568 6.14601 12.8518C6.34101 13.0468 6.65801 13.0468 6.85301 12.8518L11.353 8.35179C11.548 8.15679 11.548 7.83979 11.353 7.64478L6.85301 3.14479C6.65801 2.94979 6.34101 2.95079 6.14601 3.14579Z"/></svg>';
  // 其余小图标：同样取自 @vscode/codicons 包，fill=currentColor 跟随文字色（files 是 24 视图）。
  const ICONS = {
    close: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8.70701 8.00001L12.353 4.35401C12.548 4.15901 12.548 3.84201 12.353 3.64701C12.158 3.45201 11.841 3.45201 11.646 3.64701L8.00001 7.29301L4.35401 3.64701C4.15901 3.45201 3.84201 3.45201 3.64701 3.64701C3.45201 3.84201 3.45201 4.15901 3.64701 4.35401L7.29301 8.00001L3.64701 11.646C3.45201 11.841 3.45201 12.158 3.64701 12.353C3.74501 12.451 3.87301 12.499 4.00101 12.499C4.12901 12.499 4.25701 12.45 4.35501 12.353L8.00101 8.70701L11.647 12.353C11.745 12.451 11.873 12.499 12.001 12.499C12.129 12.499 12.257 12.45 12.355 12.353C12.55 12.158 12.55 11.841 12.355 11.646L8.70901 8.00001H8.70701Z"/></svg>',
    "link-external": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M15 9.5V12.5C15 13.879 13.879 15 12.5 15H3.5C2.121 15 1 13.879 1 12.5V3.5C1 2.121 2.121 1 3.5 1H6.5C6.776 1 7 1.224 7 1.5C7 1.776 6.776 2 6.5 2H3.5C2.673 2 2 2.673 2 3.5V12.5C2 13.327 2.673 14 3.5 14H12.5C13.327 14 14 13.327 14 12.5V9.5C14 9.224 14.224 9 14.5 9C14.776 9 15 9.224 15 9.5ZM14.5 1H9.5C9.224 1 9 1.224 9 1.5C9 1.776 9.224 2 9.5 2H13.293L9.147 6.146C8.952 6.341 8.952 6.658 9.147 6.853C9.245 6.951 9.373 6.999 9.501 6.999C9.629 6.999 9.757 6.95 9.855 6.853L14.001 2.707V6.5C14.001 6.776 14.225 7 14.501 7C14.777 7 15.001 6.776 15.001 6.5V1.5C15.001 1.224 14.777 1 14.501 1H14.5Z"/></svg>',
    discard: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M3.00098 2.5C3.00098 2.22386 3.22483 2 3.50098 2C3.77712 2 4.00098 2.22386 4.00098 2.5V6.34262L7.17202 3.17157C8.73412 1.60948 11.2668 1.60948 12.8289 3.17157C14.391 4.73367 14.391 7.26633 12.8289 8.82843L7.80375 13.8536C7.60849 14.0488 7.2919 14.0488 7.09664 13.8536C6.90138 13.6583 6.90138 13.3417 7.09664 13.1464L12.1218 8.12132C13.2933 6.94975 13.2933 5.05025 12.1218 3.87868C10.9502 2.70711 9.0507 2.70711 7.87913 3.87868L4.75781 7H8.50098C8.77712 7 9.00098 7.22386 9.00098 7.5C9.00098 7.77614 8.77712 8 8.50098 8H3.60098C3.26961 8 3.00098 7.73137 3.00098 7.4V2.5Z"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z"/></svg>',
    clippy: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.08535 2.00049C5.29127 1.41789 5.84689 1.00049 6.5 1.00049H9.5C10.1531 1.00049 10.7087 1.41789 10.9146 2.00049H11.5C12.3284 2.00049 13 2.67206 13 3.50049V8.10026C12.919 8.12889 12.8402 8.16457 12.7646 8.20715C12.4603 8.37833 12.2253 8.65027 12.1 8.97611L12 8.87618V3.50049C12 3.22435 11.7761 3.00049 11.5 3.00049H10.9146C10.7087 3.58308 10.1531 4.00049 9.5 4.00049H6.5C5.84689 4.00049 5.29127 3.58308 5.08535 3.00049H4.5C4.22386 3.00049 4 3.22435 4 3.50049V13.5005C4 13.7766 4.22386 14.0005 4.5 14.0005H8V14.5001C8.00164 14.6722 8.03284 14.8413 8.09101 15.0005H4.5C3.67157 15.0005 3 14.3289 3 13.5005V3.50049C3 2.67206 3.67157 2.00049 4.5 2.00049H5.08535ZM6.5 2.00049C6.22386 2.00049 6 2.22435 6 2.50049C6 2.77663 6.22386 3.00049 6.5 3.00049H9.5C9.77614 3.00049 10 2.77663 10 2.50049C10 2.22435 9.77614 2.00049 9.5 2.00049H6.5Z"/><path d="M11.916 10.7783C11.971 10.6959 12.0002 10.599 12 10.5C11.9998 10.4345 11.9869 10.3696 11.962 10.309C11.937 10.2484 11.9003 10.1934 11.854 10.147L9.85401 8.147C9.80801 8.09999 9.75288 8.0629 9.69201 8.038C9.63109 8.01296 9.56587 8.00005 9.50001 8C9.36766 8.00003 9.24071 8.05253 9.14701 8.146L7.14701 10.146C7.10043 10.1924 7.06346 10.2476 7.03824 10.3084C7.01301 10.3691 7.00002 10.4342 7.00001 10.5C6.99943 10.5993 7.02844 10.6965 7.08334 10.7793C7.13824 10.8621 7.21655 10.9266 7.30827 10.9647C7.39999 11.0028 7.50098 11.0127 7.59835 10.9931C7.69572 10.9736 7.78507 10.9255 7.85501 10.855L9.00001 9.708L9.00001 14.5C9.00001 14.6326 9.05269 14.7598 9.14645 14.8536C9.24022 14.9473 9.3674 15 9.50001 15C9.63262 15 9.75979 14.9473 9.85356 14.8536C9.94733 14.7598 10 14.6326 10 14.5L10 9.708L11.146 10.854C11.2159 10.9241 11.3051 10.9719 11.4022 10.9912C11.4993 11.0106 11.6 11.0007 11.6915 10.9628C11.7829 10.9249 11.8611 10.8606 11.916 10.7783Z"/><path d="M11.084 13.2217C11.0291 13.3041 10.9998 13.401 11 13.5C11.0002 13.5655 11.0131 13.6304 11.038 13.691C11.063 13.7516 11.0997 13.8066 11.146 13.853L13.146 15.853C13.192 15.9 13.2471 15.9371 13.308 15.962C13.3689 15.987 13.4341 16 13.5 16C13.6324 16 13.7593 15.9475 13.853 15.854L15.853 13.854C15.8996 13.8076 15.9365 13.7524 15.9618 13.6916C15.987 13.6309 16 13.5658 16 13.5C16.0006 13.4007 15.9716 13.3035 15.9167 13.2207C15.8618 13.1379 15.7835 13.0734 15.6917 13.0353C15.6 12.9972 15.499 12.9873 15.4017 13.0069C15.3043 13.0264 15.2149 13.0745 15.145 13.145L14 14.292V9.5C14 9.36739 13.9473 9.24021 13.8536 9.14645C13.7598 9.05268 13.6326 9 13.5 9C13.3674 9 13.2402 9.05268 13.1464 9.14645C13.0527 9.24021 13 9.36739 13 9.5V14.292L11.854 13.146C11.7841 13.0759 11.6949 13.0281 11.5978 13.0088C11.5007 12.9894 11.4 12.9993 11.3085 13.0372C11.2171 13.0751 11.1389 13.1394 11.084 13.2217Z"/></svg>',
    comment: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M1 4.5C1 3.11929 2.11929 2 3.5 2H12.5C13.8807 2 15 3.11929 15 4.5V9.5C15 10.8807 13.8807 12 12.5 12H8.68787L5.62533 14.6797C4.99168 15.2342 4 14.7842 4 13.9422V12H3.5C2.11929 12 1 10.8807 1 9.5V4.5ZM3.5 3C2.67157 3 2 3.67157 2 4.5V9.5C2 10.3284 2.67157 11 3.5 11H5V13.8981L8.31213 11H12.5C13.3284 11 14 10.3284 14 9.5V4.5C14 3.67157 13.3284 3 12.5 3H3.5Z"/></svg>',
    files: '<svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M7.5 22.5H17.595C17.07 23.4 16.11 24 15 24H7.5C4.185 24 1.5 21.315 1.5 18V6C1.5 4.89 2.1 3.93 3 3.405V18C3 20.475 5.025 22.5 7.5 22.5ZM21 8.121V18C21 19.6545 19.6545 21 18 21H7.5C5.8455 21 4.5 19.6545 4.5 18V3C4.5 1.3455 5.8455 0 7.5 0H12.879C13.4715 0 14.0505 0.24 14.4705 0.6585L20.3415 6.5295C20.766 6.954 21 7.5195 21 8.121ZM13.5 6.75C13.5 7.164 13.8375 7.5 14.25 7.5H19.1895L13.5 1.8105V6.75ZM19.5 18V9H14.25C13.0095 9 12 7.9905 12 6.75V1.5H7.5C6.672 1.5 6 2.1735 6 3V18C6 18.8265 6.672 19.5 7.5 19.5H18C18.828 19.5 19.5 18.8265 19.5 18Z"/></svg>',
    "arrow-left": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.5 8.00023H3.70701L7.85301 3.85423C8.04801 3.65923 8.04801 3.34223 7.85301 3.14723C7.65801 2.95223 7.34101 2.95223 7.14601 3.14723L2.14601 8.14723C1.95101 8.34223 1.95101 8.65923 2.14601 8.85423L7.14601 13.8542C7.24401 13.9522 7.37201 14.0002 7.50001 14.0002C7.62801 14.0002 7.75601 13.9512 7.85401 13.8542C8.04901 13.6592 8.04901 13.3422 7.85401 13.1472L3.70801 9.00123H13.501C13.777 9.00123 14.001 8.77723 14.001 8.50123C14.001 8.22523 13.777 8.00123 13.501 8.00123L13.5 8.00023Z"/></svg>',
    "arrow-right": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.854 8.14576L8.854 3.14576C8.659 2.95076 8.342 2.95076 8.147 3.14576C7.952 3.34076 7.952 3.65776 8.147 3.85276L12.293 7.99876H2.5C2.224 7.99876 2 8.22276 2 8.49876C2 8.77476 2.224 8.99876 2.5 8.99876H12.293L8.147 13.1448C7.952 13.3398 7.952 13.6568 8.147 13.8518C8.245 13.9498 8.373 13.9978 8.501 13.9978C8.629 13.9978 8.757 13.9488 8.855 13.8518L13.855 8.85176C14.05 8.65676 14.05 8.33976 13.855 8.14476L13.854 8.14576Z"/></svg>',
    "arrow-up": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.854 7.14576L8.85401 2.14576C8.65901 1.95076 8.34201 1.95076 8.14701 2.14576L3.14601 7.14576C2.95101 7.34076 2.95101 7.65776 3.14601 7.85276C3.34101 8.04776 3.65801 8.04776 3.85301 7.85276L7.99901 3.70676V13.4998C7.99901 13.7758 8.22301 13.9998 8.49901 13.9998C8.77501 13.9998 8.99901 13.7758 8.99901 13.4998V3.70676L13.145 7.85276C13.243 7.95076 13.371 7.99876 13.499 7.99876C13.627 7.99876 13.755 7.94976 13.853 7.85276C14.048 7.65776 14.048 7.34076 13.853 7.14576H13.854Z"/></svg>',
    "arrow-down": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13.854 8.146C13.659 7.951 13.342 7.951 13.147 8.146L9.00096 12.292V2.5C9.00096 2.224 8.77696 2 8.50096 2C8.22496 2 8.00096 2.224 8.00096 2.5V12.293L3.85496 8.147C3.65996 7.952 3.34296 7.952 3.14796 8.147C2.95296 8.342 2.95296 8.659 3.14796 8.854L8.14796 13.854C8.24596 13.952 8.37396 14 8.50196 14C8.62996 14 8.75796 13.951 8.85596 13.854L13.856 8.854C14.051 8.659 14.051 8.342 13.856 8.147L13.854 8.146Z"/></svg>',
    "git-branch": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M14 5.5C14 4.121 12.879 3 11.5 3C10.121 3 9 4.121 9 5.5C9 6.682 9.826 7.669 10.93 7.928C10.744 8.546 10.177 9 9.5 9H6.5C5.935 9 5.419 9.195 5 9.512V4.949C6.14 4.717 7 3.707 7 2.5C7 1.121 5.879 0 4.5 0C3.121 0 2 1.121 2 2.5C2 3.708 2.86 4.717 4 4.949V11.05C2.86 11.282 2 12.292 2 13.499C2 14.878 3.121 15.999 4.5 15.999C5.879 15.999 7 14.878 7 13.499C7 12.317 6.174 11.33 5.07 11.071C5.256 10.453 5.823 9.999 6.5 9.999H9.5C10.723 9.999 11.74 9.115 11.954 7.953C13.116 7.738 14 6.723 14 5.5ZM3 2.5C3 1.673 3.673 1 4.5 1C5.327 1 6 1.673 6 2.5C6 3.327 5.327 4 4.5 4C3.673 4 3 3.327 3 2.5ZM6 13.5C6 14.327 5.327 15 4.5 15C3.673 15 3 14.327 3 13.5C3 12.673 3.673 12 4.5 12C5.327 12 6 12.673 6 13.5ZM11.5 7C10.673 7 10 6.327 10 5.5C10 4.673 10.673 4 11.5 4C12.327 4 13 4.673 13 5.5C13 6.327 12.327 7 11.5 7Z"/></svg>',
    "merge-into": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M13 13.5C13 13.776 12.776 14 12.5 14C9.46198 14 6.99998 11.538 6.99998 8.50001V3.70701L4.35398 6.35301C4.15898 6.54801 3.84198 6.54801 3.64698 6.35301C3.45198 6.15801 3.45198 5.84101 3.64698 5.64601L7.14698 2.14601C7.34198 1.95101 7.65898 1.95101 7.85398 2.14601L11.354 5.64601C11.549 5.84101 11.549 6.15801 11.354 6.35301C11.159 6.54801 10.842 6.54801 10.647 6.35301L8.00098 3.70701V8.50001C8.00098 10.985 10.016 13 12.501 13C12.777 13 13.001 13.224 13.001 13.5H13Z"/></svg>',
  };
  const inputEl = document.getElementById("input");
  const imgPreviewEl = document.getElementById("imgPreview");
  const fileMenuEl = document.getElementById("fileMenu");
  const queueBarEl = document.getElementById("queueBar");
  const tabBarInner = document.getElementById("tabBarInner");
  const tabBarEl = document.getElementById("tabBar");
  const newTabBtn = document.getElementById("newTabBtn");
  // 输入框的起步高度：固定占 144px（约七行）；浏览器那份页面在 CSS 里把
  // --pichat-input-min-height 设成了一行，这里读出来当最小高度（读不到就用默认值，
  // 所以 VSCode 里的行为不变）。打字多了照样往上涨，上限仍然是 autoResize 里的 640px。
  const INPUT_MIN_HEIGHT_DEFAULT = 144;
  const INPUT_MIN_HEIGHT = (function () {
    try {
      const text = getComputedStyle(document.documentElement).getPropertyValue("--pichat-input-min-height");
      const parsed = parseInt(text, 10);
      if (Number.isFinite(parsed) && parsed >= 20 && parsed <= INPUT_MIN_HEIGHT_DEFAULT) { return parsed; }
    } catch { /* 读不到就用默认值 */ }
    return INPUT_MIN_HEIGHT_DEFAULT;
  })();
  newTabBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
  });
  let multiTab = false; // 收到 tabList / 带 tabId 的消息后置 true，显示 tab 栏

  // ---- tab（容器）/ panel 本地状态（后端 tabList 消息驱动）----
  // tabs map = panel（会话）渲染状态；tabViews map = tab（容器）布局与焦点。
  const tabViews = new Map();   // tabId -> { id, name, root, focusPanelId }
  let activeTabId = null;       // 活跃 tab（容器）id
  let layoutSig = "";           // 当前渲染的布局签名（变化时重建布局 DOM）
  const tabDrafts = new Map();  // tabId -> { text, selStart, selEnd, height }（输入草稿按 tab 存）
  const maximized = new Map();  // tabId -> panelId（双击 pane-head 最大化，纯前端临时态）
  let draggingPanelId = null;   // 正在拖拽的 panel id


  function enterMultiTab() {
    if (multiTab) { return; }
    multiTab = true;
    tabBarEl.classList.remove("hidden");
  }
  function ensureDefaultTab() {
    if (tabs.size === 0) {
      const st = createTab("default", "对话");
      activeId = "default";
      reflectTabUI();
    } else if (!activeId) {
      activeId = tabs.keys().next().value;
    }
    return activeTab();
  }

  // ---- 通用拾取器浮层（模型 / 历史）----
  const pickerOverlay = document.getElementById("pickerOverlay");
  const pickerBody = document.getElementById("pickerBody");
  const pickerTitle = document.getElementById("pickerTitle");
  const pickerHeader = document.getElementById("pickerHeader");
  const pickerSearch = document.getElementById("pickerSearch");
  const pickerSearchWrap = document.getElementById("pickerSearchWrap");
  const pickerFooter = document.getElementById("pickerFooter");
  let pickerState = null; // { kind, items, filtered, sel, current, draftModel, draftThinking, toggle }

  // ==================== Markdown / 文件链接 / 符号链接（纯函数，与 tab 无关）====================
  let markedReady = false;
  // 当前 highlight.js 是精简 bundle，只内置了 C++ / TypeScript / Python / plaintext。
  // 常见的 javascript/json 标签可安全按 TypeScript（JS 的超集）处理；未知标签则保持
  // 普通文本，但不能因此让整块代码继承一套固定的灰色基色。
  const HIGHLIGHT_LANGUAGE_ALIASES = Object.freeze({
    javascript: "typescript",
    ecmascript: "typescript",
    node: "typescript",
    nodejs: "typescript",
    json: "typescript",
    jsonc: "typescript",
  });
  function resolveHighlightLanguage(hljs, lang) {
    const label = String(lang || "").trim().toLowerCase().split(/\s+/)[0] || "";
    const normalized = label.replace(/^language[-_:]/, "");
    const candidate = HIGHLIGHT_LANGUAGE_ALIASES[normalized] || normalized;
    return candidate && hljs.getLanguage(candidate) ? candidate : "";
  }
  function ensureMarkedHighlight() {
    if (markedReady) { return; }
    markedReady = true;
    const { hljs, markedHighlight } = globalThis.hljsBundle || {};
    if (!hljs || !markedHighlight) { return; }
    marked.use(markedHighlight({
      langPrefix: "hljs language-",
      highlight(code, lang) {
        try {
          const language = resolveHighlightLanguage(hljs, lang);
          if (language) {
            return hljs.highlight(code, { language }).value;
          }
          return hljs.highlight(code, { language: "plaintext" }).value;
        } catch { return code; }
      }
    }));
  }

  const KNOWN_EXT = new Set([
    "js","jsx","mjs","cjs","ts","tsx","mts","cts",
    "json","json5","jsonc","css","scss","sass","less","styl",
    "html","htm","xhtml","md","mdx","markdown","rst","tex",
    "py","pyi","pyw","rb","go","rs","java","c","h","cc","cpp","cxx","hpp","hxx","cs","php","swift","kt","kts","scala","clj","cljs","cljc","edn","hs","lhs","ml","mli","fs","fsx","fsi","elm","ex","exs","erl","gleam","dart","lua","pl","pm","tcl","r","jl",
    "sh","bash","zsh","fish","bat","cmd","ps1","psm1","vim","awk",
    "vue","svelte","astro",
    "yml","yaml","toml","xml","svg","plist","resx",
    "sql","graphql","gql","proto","thrift","capnp",
    "txt","text","diff","patch","csv","tsv",
    "png","jpg","jpeg","gif","webp","ico","bmp","tiff","avif",
    "wasm","vsix","crx","jar","class","war","ear",
    "tar","gz","zip","7z","rar","bz2","xz",
    "gradle","sbt","rake","gemspec",
    "csproj","vbproj","fsproj","vcxproj","sln","props","targets",
    "dockerfile","containerfile","makefile","cmake","ninja",
  ]);
  const FILE_RE = /^((?:[\w@-]+\/)*[\w@-]+(?:\.[A-Za-z][\w-]*)+)(?::(\d+))?(?::(\d+))?$/;
  function lastExt(p) { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i + 1).toLowerCase(); }
  function isFilePathlike(path) { return KNOWN_EXT.has(lastExt(path)); }
  function escHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  // LSP 符号集合（provider 推送）：命中的反引号文本渲染成可点击符号链接。
  let symbolNames = new Set();
  function symbolLinkHTML(name, inner) {
    return `<a class="symbol-link" href="#" data-symbol="${escHtml(name)}">${inner != null ? inner : escHtml(name)}</a>`;
  }
  function fileLinkHTML(path, line, col, inner) {
    const da = escHtml(path);
    const tail = line ? ":" + line + (col ? ":" + col : "") : "";
    const dl = line ? ` data-line="${line}"` : "";
    const dc = col ? ` data-col="${col}"` : "";
    return `<a class="file-link" href="#" data-file="${da}"${dl}${dc}>${inner != null ? inner : escHtml(path) + tail}</a>`;
  }
  let fileLinkReady = false;
  function ensureFileLink() {
    if (fileLinkReady || typeof marked === "undefined") { return; }
    fileLinkReady = true;
    marked.use({
      extensions: [{
        name: "filelink",
        level: "inline",
        start(src) { const m = src.match(/[\w@-]*\/[\w@.-]*|\b[\w@-]*\.[A-Za-z]/); return m ? m.index : -1; },
        tokenizer(src) {
          const m = /^((?:[\w@-]+\/)*[\w@-]+(?:\.[A-Za-z][\w-]*)+)(?::(\d+))?(?::(\d+))?/.exec(src);
          if (!m) { return; }
          const path = m[1];
          if (!isFilePathlike(path)) { return; }
          return { type: "filelink", raw: m[0], path, line: m[2] ? parseInt(m[2], 10) : null, col: m[3] ? parseInt(m[3], 10) : null };
        },
        renderer(t) { return fileLinkHTML(t.path, t.line, t.col); },
      }],
      renderer: {
        codespan({ text }) {
          const m = FILE_RE.exec(text);
          if (m && isFilePathlike(m[1])) {
            const line = m[2] ? parseInt(m[2], 10) : null;
            const col = m[3] ? parseInt(m[3], 10) : null;
            const tail = line ? ":" + line + (col ? ":" + col : "") : "";
            return `<code>${fileLinkHTML(m[1], line, col, escHtml(m[1]) + tail)}</code>`;
          }
          if (symbolNames.has(text)) {
            return `<code>${symbolLinkHTML(text)}</code>`;
          }
          // 函数调用形态 Foo()：剥掉末尾括号后查符号集（显示保留原文，点击跳裸名）
          const callBare = text.replace(/\(\)$/, "");
          if (callBare !== text && symbolNames.has(callBare)) {
            return `<code>${symbolLinkHTML(callBare, escHtml(text))}</code>`;
          }
          return `<code>${escHtml(text)}</code>`;
        },
      },
    });
  }
  function renderInline(text) { ensureMarkedHighlight(); ensureFileLink(); return marked.parseInline(text, { gfm: true }); }
  function renderMarkdown(source) { ensureMarkedHighlight(); ensureFileLink(); return marked.parse(source, { breaks: true, gfm: true }); }

  const GEAR_SVG = '<span class="tool-icon"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M22.83,10.09 A11 11 0 0 1 22.83,13.91 L20.37,13.48 A8.5 8.5 0 0 1 18.96,16.88 A8.5 8.5 0 0 1 21.01,18.31 A11 11 0 0 1 18.31,21.01 L16.88,18.96 A8.5 8.5 0 0 1 13.48,20.37 A8.5 8.5 0 0 1 13.91,22.83 A11 11 0 0 1 10.09,22.83 L10.52,20.37 A8.5 8.5 0 0 1 7.12,18.96 A8.5 8.5 0 0 1 5.69,21.01 A11 11 0 0 1 2.99,18.31 L5.04,16.88 A8.5 8.5 0 0 1 3.63,13.48 A8.5 8.5 0 0 1 1.17,13.91 A11 11 0 0 1 1.17,10.09 L3.63,10.52 A8.5 8.5 0 0 1 5.04,7.12 A8.5 8.5 0 0 1 2.99,5.69 A11 11 0 0 1 5.69,2.99 L7.12,5.04 A8.5 8.5 0 0 1 10.52,3.63 A8.5 8.5 0 0 1 10.09,1.17 A11 11 0 0 1 13.91,1.17 L13.48,3.63 A8.5 8.5 0 0 1 16.88,5.04 A8.5 8.5 0 0 1 18.31,2.99 A11 11 0 0 1 21.01,5.69 L18.96,7.12 A8.5 8.5 0 0 1 20.37,10.52 Z"/><circle cx="12" cy="12" r="3.2"/></svg></span>';
  // 复制按钮图标：VS Code 官方 codicon copy 原始 path（fill 系图标，与 VS Code 界面同款）
  const COPY_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M3 5V12.73C2.4 12.38 2 11.74 2 11V5C2 2.79 3.79 1 6 1H9C9.74 1 10.38 1.4 10.73 2H6C4.35 2 3 3.35 3 5ZM11 15H6C4.897 15 4 14.103 4 13V5C4 3.897 4.897 3 6 3H11C12.103 3 13 3.897 13 5V13C13 14.103 12.103 15 11 15ZM12 5C12 4.448 11.552 4 11 4H6C5.448 4 5 4.448 5 5V13C5 13.552 5.448 14 6 14H11C11.552 14 12 13.552 12 13V5Z"/></svg>';
  // ==================== 全局视图选项 ====================
  var sendKeyCombo = "enter";
  var newSessionKey = "ctrl+alt+n";
  var tabSwitchKey = "ctrl+alt+pgupdown";
  var notifyOnTurnEnd = true;
  let openFiles = [];
  function applyFontSize(px) {
    var val = (typeof px === "string" && /^\d+$/.test(px)) ? px + "px" : "";
    [document.documentElement, document.body].forEach(function (el) { el.style[val ? "setProperty" : "removeProperty"]("--vscode-font-size", val); });
  }
  function applyViewOptions(opts) {
    if (typeof opts.fontSize === "string") { applyFontSize(opts.fontSize); }
    if (typeof opts.sendKey === "string") { sendKeyCombo = opts.sendKey; }
    if (typeof opts.newSessionKey === "string") { newSessionKey = opts.newSessionKey; }
    if (typeof opts.tabSwitchKey === "string") { tabSwitchKey = opts.tabSwitchKey; }
    notifyOnTurnEnd = opts.notifyOnTurnEnd !== false && opts.notifyBeep !== false;
  }

  // ── 会话结束提示音（Web Audio 合成，无外部资源） ──
  // 由扩展宿主发 "beep" 消息触发，不再只看焦点 session（多 tab / 分屏时谁跑完都响）。
  // 网页被隐藏时（窗口切到后台、侧边栏被切走、面板在后台标签里）不出声：
  // 那时 Chrome 会把音频上下文挂起，响了也听不见，交给 Windows 系统通知去提醒。
  var audioCtx = null;
  var lastBeepAt = 0;
  var BEEP_THROTTLE_MS = 600; // 多个 session 同时收尾时，只响一声
  function playTurnEndBeep() {
    try {
      if (document.hidden) { return; }
      var now = Date.now();
      if (now - lastBeepAt < BEEP_THROTTLE_MS) { return; }
      lastBeepAt = now;
      if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      if (audioCtx.state === "suspended") {
        // resume() 是异步的：第一次可能被吞掉（这正是切回来后“没声音”的常见原因），
        // 所以恢复后重试一次；重试仍被挂起才放弃。
        audioCtx.resume().then(function () {
          if (audioCtx && audioCtx.state === "running" && !document.hidden) { playBeepTone(audioCtx); }
        }).catch(function () { /* 音频不可用就忽略 */ });
        return;
      }
      playBeepTone(audioCtx);
    } catch (e) { /* 忽略音频不可用 */ }
  }
  /** 880Hz 正弦短音，约 0.25 秒渐弱。 */
  function playBeepTone(ctx) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    var t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.15, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    osc.start(t0);
    osc.stop(t0 + 0.26);
  }
  /** 预先建好音频上下文（网页刚加载、还“可见且可交互”时），降低被挂起的概率。 */
  function warmUpAudio() {
    try {
      if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      if (audioCtx.state === "suspended") { audioCtx.resume().catch(function () { /* ignore */ }); }
    } catch (e) { /* ignore */ }
  }
  function isSendKey(e) {
    if (e.key !== "Enter") { return false; }
    switch (sendKeyCombo) {
      case "shift+enter": return e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      case "alt+enter": return e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      case "ctrl+enter": return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      case "enter":
      default: return !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    }
  }

  function fmtNum(n) { if (n == null) return "0"; if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"; return String(n); }

  // ---- 全局快捷键匹配（新建会话 / 切换会话）----
  function matchCombo(e, combo) {
    // combo 形如 "ctrl+alt+n"
    const mods = combo.split("+");
    const key = mods.pop().toLowerCase();
    const wantCtrl = mods.includes("ctrl");
    const wantAlt = mods.includes("alt");
    const wantShift = mods.includes("shift");
    const wantMeta = mods.includes("meta");
    let eKey = (e.key || "").toLowerCase();
    // 规整键名
    if (eKey === "[" && e.code === "BracketLeft") { /* keep */ }
    if (eKey === "]" && e.code === "BracketRight") { /* keep */ }
    if (e.ctrlKey !== wantCtrl) { return false; }
    if (e.altKey !== wantAlt) { return false; }
    if (e.shiftKey !== wantShift) { return false; }
    if (e.metaKey !== wantMeta) { return false; }
    return eKey === key;
  }
  // tabSwitchKey 方案 -> { prev: combo, next: combo }
  function tabSwitchCombos(scheme) {
    switch (scheme) {
      case "alt+brackets": return { prev: "alt+[", next: "alt+]" };
      case "ctrl+alt+brackets": return { prev: "ctrl+alt+[", next: "ctrl+alt+]" };
      case "ctrl+alt+pgupdown": return { prev: "ctrl+alt+pageup", next: "ctrl+alt+pagedown" };
      case "ctrl+alt+arrows":
      default: return { prev: "ctrl+alt+arrowleft", next: "ctrl+alt+arrowright" };
    }
  }
  document.addEventListener("keydown", (e) => {
    // 不与输入框/搜索框冲突：仅当焦点不在输入元素时处理这些快捷键
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    // 聚焦输入框（与编辑器/终端里的 Ctrl+Alt+I / Cmd+Alt+I 一致；webview 不会把此键冒泡给 VSCode，故在此本地处理）
    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && (e.key || "").toLowerCase() === "i") {
      e.preventDefault();
      inputEl.focus();
      return;
    }
    // 新建会话（含输入框聚焦时，组合键不会误触普通输入）
    if (matchCombo(e, newSessionKey)) {
      e.preventDefault();
      vscode.postMessage({ type: "newSession" });
      return;
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      // Alt+ 类组合在输入框里也应允许（不输入字符）
      const combos = tabSwitchCombos(tabSwitchKey);
      if (matchCombo(e, combos.prev) || matchCombo(e, combos.next)) {
        e.preventDefault();
        const dir = matchCombo(e, combos.next) ? "next" : "prev";
        vscode.postMessage({ type: "switchTabByDirection", direction: dir });
      }
      return;
    }
    // 切换 tab
    const combos = tabSwitchCombos(tabSwitchKey);
    if (matchCombo(e, combos.prev)) { e.preventDefault(); vscode.postMessage({ type: "switchTabByDirection", direction: "prev" }); return; }
    if (matchCombo(e, combos.next)) { e.preventDefault(); vscode.postMessage({ type: "switchTabByDirection", direction: "next" }); return; }
  });

  // ==================== Tab 状态 ====================
  const tabs = new Map(); // id -> state
  let activeId = null;

  function activeTab() { return activeId ? tabs.get(activeId) : null; }

  function createTab(id, title) {
    let st = tabs.get(id);
    if (st) { return st; }
    const pane = document.createElement("div");
    pane.className = "tab-pane";
    pane.dataset.tabId = id;
    pane.innerHTML = '<div class="empty-hint">输入消息开始对话…</div>';
    // 不再直接挂到 #messages：由布局树渲染时挂进 layout-leaf
    pane.addEventListener("scroll", () => {
      if (!pane.isConnected) { return; }
      st.lastScrollTop = pane.scrollTop; // 滚动位置缓存：布局重建后恢复用
      if (st.programmaticScroll) { st.programmaticScroll = false; return; }
      const wasBottom = st.stickToBottom;
      st.stickToBottom = isNearBottomPane(st);
      if (wasBottom && !st.stickToBottom && st.lerpRafId) {
        cancelAnimationFrame(st.lerpRafId);
        st.lerpRafId = 0;
      }
      // 用户手动滚到底部：清掉新内容提示
      if (st.stickToBottom && st.hasNewContent) {
        st.hasNewContent = false;
        syncJumpBottom(st);
      }
    });
    st = {
      id,
      title: title || "新会话",
      paneEl: pane,
      currentAssistant: null,
      thinkingText: "",
      // 生成速度统计：本轮累计估算 token 数 / 起点时间；tps 为上一轮最终均值
      tps: undefined,
      tpsStart: 0,
      tpsTokens: 0,
      currentToolRow: null,
      pendingToolCards: new Map(),
      pendingToolTags: new Map(),
      lastTagHost: null,
      lastAssistantEl: null,
      // 刚挂过"工具图片块"（read 读图）：下面的工具调用要另起一行，不再钻进上面的正文里
      afterToolImage: false,
      // 历史窗口（网页端「只发最近一段」）：顶部按钮、加载更早的暂存区等
      hasMoreHistory: false,
      _historyBtn: null,
      _stage: null,
      _stageDropped: false,
      streaming: false,
      activity: "idle",
      activityDetail: "",
      piReady: false,
      textDirty: false,
      rafId: 0,
      lastRenderAt: 0,
      stickToBottom: true,
      lerpRafId: 0,
      programmaticScroll: false,
      hasNewContent: false,
      modelId: "",
      provider: "",
      thinkingLevel: "",
      queuedSteering: [],
      pendingSteerRestore: null,
      // 非活跃时保存的输入状态（草稿已提升为 tab 级 tabDrafts，此处仅保留占位避免旧引用报错）
      inputText: "",
      inputSelectionStart: 0,
      inputSelectionEnd: 0,
      inputHeight: INPUT_MIN_HEIGHT,
      autoLoadHinted: false,
    };
    tabs.set(id, st);
    ensurePaneHead(st);
    return st;
  }

  function hideEmptyHint(tab) {
    const hint = tab.paneEl.querySelector(".empty-hint");
    if (hint) { hint.remove(); }
  }

  /** 历史会话切换可能要等待 pi 冷启动和读盘；用 pane 内遮罩明确反馈进度。 */
  function syncSessionLoading(tab) {
    const existing = tab.paneEl.querySelector(":scope > .session-loading");
    if (!tab.loading) {
      if (existing) { existing.remove(); }
      return;
    }
    if (existing) { return; }

    const overlay = document.createElement("div");
    overlay.className = "session-loading";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    const card = document.createElement("div");
    card.className = "session-loading-card";
    const spinner = document.createElement("span");
    spinner.className = "session-loading-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("div");
    label.className = "session-loading-label";
    label.textContent = "正在加载会话";
    const detail = document.createElement("div");
    detail.className = "session-loading-detail";
    detail.textContent = "正在启动 Pi 并还原消息…";
    card.append(spinner, label, detail);
    overlay.appendChild(card);
    tab.paneEl.appendChild(overlay);
  }

  // ==================== 滚动 ====================
  const BOTTOM_THRESHOLD = 40;
  function isNearBottomPane(tab) {
    return tab.paneEl.scrollHeight - tab.paneEl.scrollTop - tab.paneEl.clientHeight <= BOTTOM_THRESHOLD;
  }
  function lerpScrollStep(tab) {
    if (!tab.stickToBottom) { tab.lerpRafId = 0; return; }
    const target = tab.paneEl.scrollHeight - tab.paneEl.clientHeight;
    const cur = tab.paneEl.scrollTop;
    const diff = target - cur;
    if (Math.abs(diff) < 1) { tab.programmaticScroll = true; tab.paneEl.scrollTop = target; tab.lerpRafId = 0; return; }
    tab.programmaticScroll = true;
    tab.paneEl.scrollTop = cur + diff * 0.3;
    tab.lerpRafId = requestAnimationFrame(() => lerpScrollStep(tab));
  }
  function smoothScrollToBottom(tab) {
    // 只对挂载在 DOM 里的 pane（当前 tab 布局内的）追底
    if (!tab.paneEl.isConnected) { return; }
    if (!tab.stickToBottom) {
      // 用户不在底部，有新内容到来：标记并显示跳转提示
      tab.hasNewContent = true;
      syncJumpBottom(tab);
      return;
    }
    if (!tab.lerpRafId) { tab.lerpRafId = requestAnimationFrame(() => lerpScrollStep(tab)); }
  }
  function scrollToBottom(tab, force) {
    if (force || tab.stickToBottom) {
      if (tab.lerpRafId) { cancelAnimationFrame(tab.lerpRafId); tab.lerpRafId = 0; }
      tab.programmaticScroll = true;
      tab.paneEl.scrollTop = tab.paneEl.scrollHeight;
      tab.stickToBottom = true;
      tab.hasNewContent = false;
      syncJumpBottom(tab);
    }
  }
  // 用户主动接管滚动（滚轮/触屏/键盘向上）：立刻停掉 lerp 追底，交还控制权。
  // 流式中同步亮起“跳到最新”按钮；非流式不打扰（用户只是回看已结束的回复）。
  function userTookOverScroll(tab) {
    if (!tab.stickToBottom) { return; }
    tab.stickToBottom = false;
    if (tab.lerpRafId) { cancelAnimationFrame(tab.lerpRafId); tab.lerpRafId = 0; }
    if (tab.streaming) { tab.hasNewContent = true; syncJumpBottom(tab); }
  }
  // 控制“跳到最新”按钮显隐（仅活跃 tab 生效）
  function syncJumpBottom(tab) {
    if (!jumpBottomBtn) { return; }
    const show = tab.hasNewContent && !tab.stickToBottom && activeId === tab.id;
    jumpBottomBtn.classList.toggle("hidden", !show);
  }

  // ==================== 流式渲染节流 ====================
  function renderInterval(rawLen) {
    if (rawLen < 4000) return 0;
    if (rawLen < 16000) return 60;
    if (rawLen < 64000) return 150;
    return 300;
  }
  function isSelectingIn(el) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { return false; }
    const range = sel.getRangeAt(0);
    return !!(el && el.contains(range.startContainer));
  }
  function scheduleFlush(tab) { if (!tab.rafId) { tab.rafId = requestAnimationFrame(() => flushDeltas(tab)); } }
  function flushDeltas(tab) {
    tab.rafId = 0;
    const now = performance.now();
    if (tab.textDirty && tab.currentAssistant) {
      const raw = tab.currentAssistant.raw || "";
      const interval = renderInterval(raw.length);
      if (interval > 0 && now - tab.lastRenderAt < interval) {
        tab.rafId = requestAnimationFrame(() => flushDeltas(tab));
      } else if (activeId === tab.id && isSelectingIn(tab.currentAssistant.el)) {
        tab.rafId = requestAnimationFrame(() => flushDeltas(tab));
      } else {
        tab.currentAssistant.el.innerHTML = renderMarkdown(raw);
        tab.currentAssistant.el.dataset.raw = raw;
        tab.lastRenderAt = now;
        tab.textDirty = false;
      }
    }
    smoothScrollToBottom(tab);
  }
  function cancelFlush(tab) { if (tab.rafId) { cancelAnimationFrame(tab.rafId); tab.rafId = 0; } tab.textDirty = false; }
  function finalizeCurrentAssistant(tab) {
    cancelFlush(tab);
    if (tab.currentAssistant) {
      tab.currentAssistant.el.innerHTML = renderMarkdown(tab.currentAssistant.raw || "");
      tab.currentAssistant.el.dataset.raw = tab.currentAssistant.raw || "";
      smoothScrollToBottom(tab);
      tab.currentAssistant = null;
    }
  }

  // ==================== 消息 DOM ====================
  function countLines(text) { let n = 0; for (let i = 0; i < text.length; i++) { if (text.charCodeAt(i) === 10) { n++; } } return n + 1; }
  const LONG_MSG_PREVIEW_LINES = 5;
  const BIG_TEXT_LINES = 10;
  const BIG_TEXT_CHARS = 8000;
  function shouldFoldText(text) {
    if (typeof text !== "string" || !text) { return false; }
    if (text.length > BIG_TEXT_CHARS) { return true; }
    return countLines(text) > BIG_TEXT_LINES;
  }
  function makeLongTextBody(text) {
    const body = document.createElement("div");
    body.className = "long-msg";
    const pre = document.createElement("pre");
    const lines = text.split("\n");
    const total = lines.length;
    pre.textContent = lines.slice(0, LONG_MSG_PREVIEW_LINES).join("\n") + (total > LONG_MSG_PREVIEW_LINES ? "\n…" : "");
    body.appendChild(pre);
    if (total > LONG_MSG_PREVIEW_LINES) {
      const toggle = document.createElement("span");
      toggle.className = "lm-toggle";
      toggle.textContent = "展开全部（共 " + total + " 行）";
      let expanded = false;
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        if (expanded) { pre.classList.add("full"); pre.textContent = text; toggle.textContent = "收起（共 " + total + " 行）"; }
        else { pre.classList.remove("full"); pre.textContent = lines.slice(0, LONG_MSG_PREVIEW_LINES).join("\n") + "\n…"; toggle.textContent = "展开全部（共 " + total + " 行）"; }
      });
      body.appendChild(toggle);
    }
    return body;
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }

  function addPlain(tab, cls, role, text) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    tab.lastTagHost = null; // 新消息块：工具标签不再往上一段后面续
    tab.lastAssistantEl = null;
    const div = document.createElement("div");
    div.className = "msg " + cls + " msg-enter";
    if (cls === "user") { div.dataset.raw = text || ""; }
    const content = text || "";
    if (cls === "user" && shouldFoldText(content)) {
      div.appendChild(makeLongTextBody(content));
    } else {
      const body = document.createElement("div");
      body.textContent = content;
      div.appendChild(body);
    }
    if (cls === "assistant") { attachCopyBtn(div, () => content); }
    tab.paneEl.appendChild(div);
    scrollToBottom(tab);
    return div.firstElementChild;
  }
  /** 给消息气泡右下角挂一个复制按钮（hover 时显示），getText 返回要复制的原文。 */
  function attachCopyBtn(div, getText) {
    const btn = document.createElement("button");
    btn.className = "msg-copy"; btn.type = "button"; btn.title = "复制回复";
    btn.innerHTML = COPY_SVG;
    btn.addEventListener("click", async () => {
      await copyToClipboard(getText() || "");
      btn.classList.add("copied"); btn.title = "已复制";
      setTimeout(() => { btn.classList.remove("copied"); btn.title = "复制回复"; }, 1500);
    });
    div.appendChild(btn);
  }

  function addMarkdown(tab, raw) {
    hideEmptyHint(tab);
    tab.currentToolRow = null;
    tab.lastTagHost = null; // 新正文块：工具标签不再往上一段后面续
    const div = document.createElement("div");
    div.className = "msg assistant msg-enter";
    const body = document.createElement("div");
    body.className = "md";
    body.dataset.raw = raw || "";
    body.innerHTML = renderMarkdown(raw || "");
    attachCopyBtn(div, () => body.dataset.raw || "");
    div.appendChild(body);
    tab.paneEl.appendChild(div);
    tab.lastAssistantEl = body; // 工具标签要接在这条正文的行尾
    scrollToBottom(tab);
    return body;
  }

  /** 工具标签挂载点：优先接在上一条助手消息正文的行尾（行内续排）；
   *  正文以代码块 / 表格等块级元素结尾时跟在块后面；
   *  还没有任何正文（工具先于文字）时退回独立一行。 */
  function toolTagHost(tab) {
    // 刚挂过"工具图片块"（read 读图）：它下面的工具从新的一行开始排。
    // 这里把上一行的状态全清掉，否则标签会回到图片块上面那条正文里（顺序就反了）。
    if (tab.afterToolImage) {
      tab.afterToolImage = false;
      tab.lastAssistantEl = null;
      tab.lastTagHost = null;
      tab.currentToolRow = null;
    }
    // 注意：tool 事件到达前会先 finalizeCurrentAssistant（它会清空 currentAssistant），
    // 所以“上一条助手正文”主要靠 lastAssistantEl 这个持久引用。
    const asstEl = (tab.currentAssistant && tab.currentAssistant.el && tab.currentAssistant.el.isConnected)
      ? tab.currentAssistant.el
      : (tab.lastAssistantEl && tab.lastAssistantEl.isConnected ? tab.lastAssistantEl : null);
    if (asstEl) {
      const last = asstEl.lastElementChild;
      // 普通段落 / 列表项结尾：标签进段落里，跟正文同一行内续排
      if (last && (last.tagName === "P" || last.tagName === "LI")) { return last; }
      return asstEl;
    }
    // 连续多个工具调用：继续追加到上一个标签所在的宿主
    if (tab.lastTagHost && tab.lastTagHost.isConnected) { return tab.lastTagHost; }
    // 兜底：独立一行
    if (!tab.currentToolRow) {
      tab.currentToolRow = document.createElement("div");
      tab.currentToolRow.className = "msg tool-row msg-enter";
      tab.paneEl.appendChild(tab.currentToolRow);
    }
    return tab.currentToolRow;
  }

  /** 把标签挂进宿主：行内宿主在首个标签前补个空格与正文隔开。 */
  function mountToolTag(tab, tag) {
    const host = toolTagHost(tab);
    const inline = host !== tab.currentToolRow;
    if (inline && !host._hasTags) {
      host.appendChild(document.createTextNode(" "));
      host._hasTags = true;
    }
    host.appendChild(tag);
    if (inline) { tab.lastTagHost = host; }
  }

  function addTool(tab, toolName, argStr, toolCallId) {
    hideEmptyHint(tab);
    const tag = document.createElement("span");
    tag.className = "tool" + (toolCallId ? " running" : "");
    tag.insertAdjacentHTML("afterbegin", GEAR_SVG);
    tag.appendChild(document.createTextNode(" " + toolName));
    // 悬浮提示显示调用与结果（见 showTagTip）；read 读图的结果也在提示框里出图。
    tag._toolName = toolName;
    tag._argStr = argStr;
    tag._resultText = "";
    tag._resultMeta = {};
    tag._isError = false;
    tag._done = !toolCallId; // 无 id 的静态调用无结果事件，按已完成处理
    // 提示内容：运行中显示调用参数（输入）；结果到达后由 setTagTip 填入全部原文（输出）。
    // 带图片的结果（read 读图这类）不走提示框：结果到了会把这个标签整个换成对话里的一块图，
    // 见 mountToolImageBlock。
    tag._tipCall = tagTipCallText(toolName, argStr);
    tag._tipBody = "";
    if (IS_TOUCH_DEVICE) {
      // 触屏没有悬浮：点一下显示提示框，再点一下（或点提示框外面）关闭
      tag.addEventListener("click", () => {
        if (tagTipTag === tag) { hideTagTip(); } else { showTagTip(tag); }
      });
    } else {
      // 电脑悬浮显示；从标签移进提示框不收，两边都离开才收（见 scheduleTagTipHide）
      tag.addEventListener("mouseenter", () => showTagTip(tag));
      tag.addEventListener("mouseleave", scheduleTagTipHide);
    }
    mountToolTag(tab, tag);
    if (toolCallId) { tab.pendingToolTags.set(toolCallId, tag); }
    scrollToBottom(tab);
  }

  // ==================== 完整模式：TUI 风格工具卡片 ====================
  // 有定制调用行摘要的工具（与 pi TUI 一致），其余工具回退为加粗工具名 + pretty JSON 参数。
  const CUSTOM_CALL_TOOLS = new Set(["bash", "grep", "find", "ls", "read"]);
  const TOOL_PREVIEW_LINES = 6; // 结果预览行数（同 TUI BASH_PREVIEW_LINES +1，因底部截断标记更紧凑）

  function prettyJson(argStr) {
    try { return JSON.stringify(JSON.parse(argStr), null, 2); }
    catch { return argStr; }
  }
  function formatDur(ms) {
    const s = ms / 1000;
    if (s < 60) { return s.toFixed(1) + "s"; }
    const m = Math.floor(s / 60);
    const rs = Math.round(s % 60);
    return m + "m" + (rs ? rs + "s" : "");
  }
  /** 生成工具 call 行（对齐 TUI renderCall：加粗工具名 + accent pattern + 灰参数）。 */
  function buildToolCallEl(toolName, argStr) {
    const call = document.createElement("div");
    call.className = "tc-call";
    let a = null;
    try { a = argStr ? JSON.parse(argStr) : {}; } catch { a = null; }
    const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; call.appendChild(s); };
    const strArg = (key) => (a && typeof a[key] === "string" ? a[key] : undefined);
    switch (toolName) {
      case "bash":
        span("tc-call-name", "$ " + (strArg("command") || "..."));
        if (a && typeof a.timeout === "number") { span("tc-call-arg", " (timeout " + a.timeout + "s)"); }
        break;
      case "grep":
        span("tc-call-name", "grep");
        span("tc-call-param", " /" + (strArg("pattern") || "") + "/");
        span("tc-call-arg", " in " + (strArg("path") || "."));
        if (a && a.glob) { span("tc-call-arg", " (" + a.glob + ")"); }
        if (a && typeof a.limit === "number") { span("tc-call-arg", " limit " + a.limit); }
        break;
      case "find":
        span("tc-call-name", "find");
        span("tc-call-param", " " + (strArg("pattern") || ""));
        span("tc-call-arg", " in " + (strArg("path") || "."));
        if (a && typeof a.limit === "number") { span("tc-call-arg", " (limit " + a.limit + ")"); }
        break;
      case "ls":
        span("tc-call-name", "ls");
        span("tc-call-arg", " " + (strArg("path") || "."));
        if (a && typeof a.limit === "number") { span("tc-call-arg", " (limit " + a.limit + ")"); }
        break;
      case "read": {
        span("tc-call-name", "read");
        span("tc-call-arg", " " + (strArg("file_path") || strArg("path") || ""));
        const off = a && typeof a.offset === "number" ? a.offset : undefined;
        const lim = a && typeof a.limit === "number" ? a.limit : undefined;
        if (off !== undefined || lim !== undefined) {
          // 行范围：start = offset ?? 1，end = start + limit - 1（同 TUI formatReadLineRange）
          const start = off ?? 1;
          const end = lim !== undefined ? start + lim - 1 : start;
          span("tc-call-warn", " " + start + ":" + end);
        }
        break;
      }
      case "write":
      case "edit":
        span("tc-call-name", toolName);
        span("tc-call-arg", " " + (strArg("file_path") || strArg("path") || ""));
        break;
      default:
        span("tc-call-name", toolName);
    }
    return call;
  }

  /** 摘要模式：生成标签内的单行调用摘要。复用 buildToolCallEl 排版（inline 布局）；
   *  非定制工具兑底为“工具名 + 单行 JSON 参数”，超长交给 CSS 省略号。 */
  function buildMediumSummary(toolName, argStr) {
    const call = buildToolCallEl(toolName, argStr);
    call.className = "tc-inline";
    if (!CUSTOM_CALL_TOOLS.has(toolName) && toolName !== "write" && toolName !== "edit" && argStr) {
      let one = argStr;
      try { one = JSON.stringify(JSON.parse(argStr)); } catch { one = argStr.replace(/\s+/g, " "); }
      const s = document.createElement("span"); s.className = "tc-call-arg"; s.textContent = " " + one;
      call.appendChild(s);
    }
    return call;
  }

  // ==================== 工具标签提示框 ====================
  // 鼠标停在工具标签上（触屏设备改为点一下标签），用自绘的提示框显示调用与结果。
  // 系统自带的 title 提示要等约一秒才出现，这里电脑上悬浮 TAG_TIP_DELAY_MS 就出。
  // 运行中只显示调用参数（输入）；结果到达后显示「调用 + 结果」两块，结果放
  // pi 发来的全部原文不再截断——提示框内容区可滚动。关闭方式：电脑鼠标移开或点别处，
  // 触屏点提示框外面或再点一下标签。
  /** 调用摘要的单行纯文本（复用摘要排版，如 bash → "$ npm test"）。 */
  function tagTipCallText(toolName, argStr) {
    try { return buildMediumSummary(toolName, argStr).textContent.trim() || toolName; }
    catch (e) { return toolName; }
  }
  /** 结果到达后更新标签提示：结果放全部原文；note 非空时用它替代（如 read 读图）。 */
  function setTagTip(tag, resultText, note) {
    tag._tipBody = note || (resultText || "");
    refreshTagTipIfShowing(tag);
  }

  // 自绘提示框：全局复用同一个元素。外框（含右上角关闭按钮）+ 内容区（可滚动）。
  // 内容区分两块：调用一行（输入）、结果一块稍深底色（输出）。
  const TAG_TIP_DELAY_MS = 200; // 电脑上悬浮多久后出现
  const TAG_TIP_HIDE_GRACE_MS = 150; // 电脑上鼠标离开后宽限多久再收（移进提示框的间隙不闪没）
  let tagTipEl = null;      // 外框
  let tagTipContent = null; // 内容区（可滚动）
  let tagTipTimer = 0;      // 电脑上的悬浮延迟计时
  let tagTipHideTimer = 0;  // 电脑上的鼠标离开宽限计时
  let tagTipTag = null;

  function hideTagTip() {
    if (tagTipHideTimer) { clearTimeout(tagTipHideTimer); tagTipHideTimer = 0; }
    if (tagTipTimer) { clearTimeout(tagTipTimer); tagTipTimer = 0; }
    tagTipTag = null;
    if (tagTipEl) { tagTipEl.classList.add("hidden"); }
  }
  function cancelTagTipHide() {
    if (tagTipHideTimer) { clearTimeout(tagTipHideTimer); tagTipHideTimer = 0; }
  }
  /** 电脑上鼠标离开标签/提示框后，宽限片刻再收，期间移回任一方就取消。 */
  function scheduleTagTipHide() {
    cancelTagTipHide();
    tagTipHideTimer = setTimeout(() => { tagTipHideTimer = 0; hideTagTip(); }, TAG_TIP_HIDE_GRACE_MS);
  }
  /** 把标签的调用与结果填进内容区：调用一行稍深底色（输入），结果原样（输出）。 */
  function fillTagTip(tag) {
    tagTipContent.textContent = "";
    // 自定义内容钩子（edit/write 标签用：标题行 + diff / 写入预览 + 跳转 / 回滚按钮）
    if (tag._tipFill) { tag._tipFill(tagTipContent); return; }
    tagTipContent.textContent = "";
    const call = document.createElement("div");
    call.className = "tag-tip-call";
    call.textContent = tag._tipCall || "";
    tagTipContent.appendChild(call);
    if (tag._tipBody) {
      const result = document.createElement("div");
      result.className = "tag-tip-result";
      result.textContent = tag._tipBody;
      tagTipContent.appendChild(result);
    }
  }
  function showTagTip(tag) {
    // 已在显示同一个标签（如鼠标从提示框移回标签）：只刷新位置，不闪没再闪出
    if (tagTipTag === tag && tagTipEl && !tagTipEl.classList.contains("hidden")) {
      cancelTagTipHide();
      placeTagTip(tagTipEl, tag);
      return;
    }
    hideTagTip();
    if (!tag._tipCall && !tag._tipFill) { return; }
    tagTipTag = tag;
    const render = () => {
      tagTipTimer = 0;
      if (tagTipTag !== tag || !tag.isConnected) { return; }
      if (!tagTipEl) {
        tagTipEl = document.createElement("div");
        tagTipEl.className = "tag-tip hidden";
        tagTipContent = document.createElement("div");
        tagTipContent.className = "tag-tip-content";
        tagTipEl.appendChild(tagTipContent);
        document.body.appendChild(tagTipEl);
        if (!IS_TOUCH_DEVICE) {
          // 电脑：鼠标在提示框上不算离开，从标签移进来不收，再移出去才收
          tagTipEl.addEventListener("mouseenter", cancelTagTipHide);
          tagTipEl.addEventListener("mouseleave", scheduleTagTipHide);
        }
      }
      fillTagTip(tag);
      tagTipEl.classList.remove("hidden");
      placeTagTip(tagTipEl, tag);
    };
    // 触屏设备没有悬浮：点一下是明确动作，立即显示；电脑上悬浮短暂停留后再显示
    if (IS_TOUCH_DEVICE) { render(); } else { tagTipTimer = setTimeout(render, TAG_TIP_DELAY_MS); }
  }
  /** 显示期间内容更新（如结果刚到）时，刷新正在显示的提示内容与位置。 */
  function refreshTagTipIfShowing(tag) {
    if (tagTipTag !== tag || !tagTipEl || tagTipEl.classList.contains("hidden")) { return; }
    fillTagTip(tag);
    placeTagTip(tagTipEl, tag);
  }
  function placeTagTip(el, tag) {
    const r = tag.getBoundingClientRect();
    el.style.maxWidth = Math.max(160, Math.min(640, window.innerWidth - 16)) + "px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w));
    let y = r.bottom + 6;
    if (y + h > window.innerHeight - 8) {
      const above = r.top - h - 6;
      y = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - h);
    }
    el.style.left = x + "px";
    el.style.top = y + "px";
  }
  // 内容滚动或窗口变化后提示位置会错位，直接收起；滚动提示框自己（看长结果）不算。
  document.addEventListener("scroll", (e) => {
    if (tagTipEl && tagTipEl.contains(e.target)) { return; }
    hideTagTip();
  }, true);
  window.addEventListener("resize", hideTagTip);
  // 点提示框和当前标签以外任何地方关闭提示框（触屏主要靠这个和右上角 × 收）。
  document.addEventListener("click", (e) => {
    if (!tagTipEl || tagTipEl.classList.contains("hidden")) { return; }
    if (tagTipEl.contains(e.target)) { return; } // 点提示框本身不关（要滚动看内容）
    if (tagTipTag && tagTipTag.contains(e.target)) { return; } // 点当前标签交给标签自己处理（切换关闭）
    hideTagTip();
  });

  /** write 参数区：内容预览（前 10 行，同 TUI formatWriteCall）。
   *  截断部分不支持点击展开（卡片内展开体验差且容易误触），改用右上角“跳转”按钮打开完整文件。 */
  function buildWritePreviewEl(argStr) {
    let a = null;
    try { a = argStr ? JSON.parse(argStr) : {}; } catch { a = null; }
    const content = a && typeof a.content === "string" ? a.content : "";
    if (!content) { return null; }
    const lines = content.split("\n");
    const total = lines.length;
    const MAX_LINES = 10;
    const preview = lines.slice(0, MAX_LINES).join("\n");
    const wrap = document.createElement("div");
    wrap.className = "tc-args";
    wrap.appendChild(document.createTextNode(preview));
    if (total > MAX_LINES) {
      const hint = document.createElement("div");
      hint.className = "tc-trunc-hint";
      hint.textContent = "... (" + (total - MAX_LINES) + " 行未显示,共 " + total + " 行)";
      hint.title = "点击右上角“跳转”按钮查看完整文件";
      wrap.appendChild(hint);
    }
    return wrap;
  }

  // ==================== 工具结果内联图片（read 读图等） ====================
  /** Lightbox：点击缩略图全屏查看原图，点任意处关闭。 */
  let lightboxEl = null;
  function openLightbox(src) {
    if (!lightboxEl) {
      lightboxEl = document.createElement("div");
      lightboxEl.className = "lightbox hidden";
      lightboxEl.appendChild(document.createElement("img"));
      lightboxEl.addEventListener("click", () => { lightboxEl.classList.add("hidden"); });
      document.body.appendChild(lightboxEl);
    }
    lightboxEl.firstChild.src = src;
    lightboxEl.classList.remove("hidden");
  }

  /** 图片原始尺寸写进调用行（read xxx 后面）；medium 模式无调用行则写进标签标题。 */
  function applyImageDims(card, w, h) {
    if (!card || card._dimsApplied || !w || !h) { return; }
    card._dimsApplied = true;
    const host = card.querySelector(".tc-call") || card.querySelector("span.tool") || card.querySelector(".tib-head");
    if (!host) { return; }
    let s = host.querySelector(".tc-dims");
    if (!s) {
      s = document.createElement("span"); s.className = "tc-dims";
      host.appendChild(s);
    }
    s.textContent = w + "x" + h;
  }

  /** 结果区图片块：缩略图 + 点击放大；后端对超大图只传 tooLarge 占位。 */
  function renderResultImages(resultEl, images, card) {
    if (!Array.isArray(images) || images.length === 0) { return; }
    const wrap = document.createElement("div"); wrap.className = "tc-images";
    for (const img of images) {
      if (!img || img.tooLarge || typeof img.data !== "string" || !img.data) {
        const ph = document.createElement("div"); ph.className = "tc-img-too-large";
        const mb = img && typeof img.bytes === "number" ? (img.bytes / 1048576).toFixed(1) + " MB" : "超过上限";
        ph.textContent = "[图片过大 " + mb + "，未内联显示]";
        wrap.appendChild(ph);
        continue;
      }
      const el = document.createElement("img");
      el.className = "tc-img";
      el.src = "data:" + (img.mimeType || "image/png") + ";base64," + img.data;
      el.title = "点击放大";
      el.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(el.src); });
      el.addEventListener("load", () => { applyImageDims(card, el.naturalWidth, el.naturalHeight); }, { once: true });
      wrap.appendChild(el);
    }
    resultEl.appendChild(wrap);
  }

  /** 从工具参数里取出文件名（只留最后一段）：参数长这样 {"file_path":"D:/a/b.png"} 或 {"path":"..."}。
   *  取不到就返回空串，调用方回退到原来的摘要文字。 */
  function fileNameFromArgs(argStr) {
    try {
      const a = JSON.parse(argStr || "{}");
      const raw = a && (a.file_path || a.path);
      if (typeof raw !== "string" || !raw) { return ""; }
      const parts = raw.split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : raw;
    } catch (e) {
      return "";
    }
  }

  /**
   * 工具结果带图片（read 读图这类）：把这个小标签换成对话里的一整块 ——
   * 上面一行说明（齿轮 + 工具名 / 文件名，图片尺寸到了再补上），下面把图完整铺出来。
   *
   * 为什么不用悬浮提示：图藏在提示框里要鼠标悬上去才看得到，而"读了哪张图"本身就是对话内容。
   * 块自己占一行（不跟正文挤在同一行里）；它后面的工具调用另起一行重新排
   * （见 toolTagHost 的 afterToolImage）。
   */
  function mountToolImageBlock(tab, tagEl, images) {
    if (!Array.isArray(images) || images.length === 0) { return; }
    const block = document.createElement("div");
    block.className = "tool-image-block msg-enter";
    const head = document.createElement("div");
    head.className = "tib-head";
    head.insertAdjacentHTML("afterbegin", GEAR_SVG);
    const text = document.createElement("span");
    text.className = "tib-text";
    // 说明行只写文件名（整条路径太长，把图片挤下去了）；想看完整路径就把鼠标停在上面
    const name = tagEl._toolName || "";
    const file = fileNameFromArgs(tagEl._argStr);
    text.textContent = name && file ? (name + " " + file) : (tagEl._tipCall || (tagEl.textContent || "").trim());
    text.title = tagEl._tipCall || text.textContent;
    head.appendChild(text);
    block.appendChild(head);
    // 图直接接在说明行下面；图加载完成后尺寸会写回说明行（见 applyImageDims）
    renderResultImages(block, images, block);
    // 原来那个小标签收掉：它跟图片本来就是一回事，不留两份
    const host = tagEl.parentElement;
    tagEl.remove();
    // 标签所在的段落/行被收空了就一起收掉（同一行还有别的工具或正文时不收）
    if (host && host !== tab.paneEl
      && (host.tagName === "P" || host.tagName === "LI" || host.classList.contains("tool-row"))
      && !host.textContent.trim() && host.childElementCount === 0) {
      host.remove();
    }
    tab.paneEl.appendChild(block);
    tab.afterToolImage = true;
    scrollToBottom(tab);
  }

  /** 卡片结果区渲染：预览截断（尾部 N 行，同 TUI）+ 元信息 + 展开/收起。 */
  function renderDiffBlock(tab, diffText, filePath) {
    const wrap = document.createElement("div");
    wrap.className = "edit-diff";
    // 内层收缩包裹：宽度 = max(卡片宽, 最宽行)，让所有行背景一致铺满，横向滚动时短行不断色
    const inner = document.createElement("div");
    inner.className = "edit-diff-inner";
    wrap.appendChild(inner);
    const LINE_RE = /^([+-]?) *(\d+) (.*)$/;
    const lines = String(diffText).split("\n");
    for (const line of lines) {
      const div = document.createElement("div");
      div.className = "diff-line";
      const prefix = line.charAt(0);
      if (prefix === "+") div.classList.add("add");
      else if (prefix === "-") div.classList.add("del");
      else div.classList.add("ctx");
      div.textContent = line;
      const m = filePath && line.match(LINE_RE);
      if (m && (m[1] === "+" || m[1] === "-")) {
        const target = parseInt(m[2], 10);
        const anchor = m[1] === "+" ? m[3] : undefined;
        div.classList.add("jumpable");
        div.title = "跳转到第 " + target + " 行";
        div.addEventListener("click", () => {
          vscode.postMessage({ type: "openEditLocation", tabId: tab.id, path: filePath, line: target, anchor });
        });
      }
      inner.appendChild(div);
    }
    return wrap;
  }

  function buildEditCard(tab, toolName, label, filePath, toolCallId, argStr) {
    hideEmptyHint(tab);
    // 收起态：跟普通工具调用一样的「齿轮 + 工具名」小标签，混进工具标签行；文件路径在悬浮提示里看。
    const pill = document.createElement("span");
    pill.className = "tool et-pill" + (toolCallId ? " running" : "");
    pill.insertAdjacentHTML("afterbegin", GEAR_SVG);
    pill.appendChild(document.createTextNode(" " + toolName));
    mountToolTag(tab, pill);
    scrollToBottom(tab);

    let pendingResult = null;   // 结果（含 diff）：提示框随取随画
    let resultDone = false;
    let reverted = false;

    /** 悬浮提示内容：标题行（工具名 + 路径 + 状态）+ diff / 写入预览 + 跳转 / 回滚按钮。 */
    function fillTip(content) {
      const head = document.createElement("div");
      head.className = "tag-tip-call";
      head.textContent = toolName + " " + (label || filePath || "") + (reverted ? "（已回滚）" : "");
      content.appendChild(head);
      if (resultDone && pendingResult) {
        if (pendingResult.isError) {
          const err = document.createElement("div");
          err.className = "tip-err";
          err.textContent = pendingResult.errorText || "失败";
          content.appendChild(err);
        } else {
          // edit 显示完整 diff；write 显示写入内容预览（前 10 行）
          if (toolName !== "write" && pendingResult.diff) {
            content.appendChild(renderDiffBlock(tab, pendingResult.diff, filePath));
          } else if (toolName === "write") {
            const pv = buildWritePreviewEl(argStr);
            if (pv) { content.appendChild(pv); }
          }
          // 按钮：write 给「跳转」，edit 成功且可回滚给「回滚」
          if (toolName === "write" && filePath) {
            const jumpBtn = document.createElement("span"); jumpBtn.className = "et-jump"; jumpBtn.innerHTML = '跳转 ' + ICONS["link-external"];
            jumpBtn.title = "在编辑器中打开 " + (label || filePath);
            jumpBtn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "openFile", path: filePath, line: 1 }); });
            content.appendChild(jumpBtn);
          } else if (pendingResult.canRevert && toolCallId && !reverted) {
            const revertBtn = document.createElement("span"); revertBtn.className = "et-revert"; revertBtn.innerHTML = ICONS.discard + ' 回滚';
            revertBtn.title = "将文件恢复到本次修改前的内容";
            revertBtn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "revertEdit", tabId: tab.id, toolCallId }); });
            content.appendChild(revertBtn);
          }
        }
      } else if (toolCallId) {
        const loading = document.createElement("div");
        loading.className = "tip-loading";
        loading.textContent = "生成中…";
        content.appendChild(loading);
      }
    }
    pill._tipFill = fillTip;

    // 与普通工具标签同一套触发：触屏点按切换（点外面关），桌面悬浮（带延迟与宽限）
    if (IS_TOUCH_DEVICE) {
      pill.addEventListener("click", () => {
        if (tagTipTag === pill) { hideTagTip(); } else { showTagTip(pill); }
      });
    } else {
      pill.addEventListener("mouseenter", () => showTagTip(pill));
      pill.addEventListener("mouseleave", scheduleTagTipHide);
    }

    return {
      setResult(msg) {
        resultDone = true;
        pendingResult = msg;
        pill.classList.remove("running");
        if (msg.isError) { pill.classList.add("error"); }
        refreshTagTipIfShowing(pill);
      },
      markReverted() {
        reverted = true;
        pill.classList.remove("running");
        pill.classList.add("reverted");
        refreshTagTipIfShowing(pill);
      },
    };
  }
  function renderQueueBar(tab) {
    if (activeId !== tab.id) { return; }
    const items = tab.queuedSteering || [];
    if (!items.length) { queueBarEl.classList.add("hidden"); queueBarEl.innerHTML = ""; return; }
    queueBarEl.classList.remove("hidden");
    queueBarEl.innerHTML = "";
    const title = document.createElement("div");
    title.className = "qb-title";
    title.textContent = "已排队 " + items.length + " 条（工具执行后投递）";
    queueBarEl.appendChild(title);
    items.forEach((text, idx) => {
      const full = typeof text === "string" ? text : "";
      const lines = full.split("\n");
      const lineCount = lines.length;
      const preview = lines.slice(0, 3).join("\n") + (lineCount > 3 ? "\n…" : "");
      const card = document.createElement("div");
      card.className = "qb-block collapsed";
      const head = document.createElement("div");
      head.className = "qb-head";
      const dot = document.createElement("span"); dot.className = "qb-dot";
      const label = document.createElement("span"); label.className = "qb-label";
      label.textContent = "等待投递";
      const previewLine = document.createElement("span"); previewLine.className = "qb-preview";
      previewLine.textContent = (lines[0] || "").trim();
      const toggle = document.createElement("span"); toggle.className = "qb-toggle";
      toggle.textContent = "已排队 · 点击展开（" + lineCount + " 行）";
      head.appendChild(dot); head.appendChild(label); head.appendChild(previewLine); head.appendChild(toggle);
      const body = document.createElement("pre"); body.className = "qb-body";
      body.textContent = preview;
      card.appendChild(head); card.appendChild(body);
      head.addEventListener("click", () => {
        const collapsed = card.classList.toggle("collapsed");
        if (!collapsed) { body.textContent = full; toggle.textContent = "收起（" + lineCount + " 行）"; }
        else { body.textContent = preview; toggle.textContent = "已排队 · 点击展开（" + lineCount + " 行）"; }
      });
      queueBarEl.appendChild(card);
    });
  }

  // ==================== UI 同步（活跃 tab 驱动全局控件）====================
  /** 当前 tab 里正在生成的 panel：Esc 中止与网页端的“停止生成”图标共用这一处判断。 */
  function activeStreamingLeaves() {
    const tv = tabViews.get(activeTabId);
    if (!tv) { return []; }
    return leavesOf(tv.root).filter((pid) => {
      const t = tabs.get(pid);
      return !!t && t.streaming;
    });
  }

  /** 输入框里那颗“停止生成”图标（只有网页端有）：当前 tab 里还有 panel 在生成时才露面。 */
  function syncStopBtn() {
    if (!stopBtn) { return; }
    stopBtn.classList.toggle("hidden", activeStreamingLeaves().length === 0);
    stopBtn.disabled = false;
  }

  function updateSendState() {
    // VSCode 里发送/中止只看键盘（Enter 发送、Esc 中止），没有按钮；状态文案由 syncStatus 负责。
    // 网页端（尤其手机）没有 Esc：输入框里那颗“停止生成”图标随生成中与否显示 / 隐藏。
    syncStopBtn();
  }
  // 状态栏常显模型：这些纯函数拼出模型名前缀与用量百分比标签。
  function modelPartFor(tab) {
    const id = (tab && tab.modelId) || "";
    const prov = (tab && tab.provider) || "";
    return id ? ((prov ? prov + "/" : "") + id) : "";
  }
  let tpsSyncAt = 0;
  // delta 高频到达，速度刷新做 250ms 节流（当前 tab 内所有可见 pane 都要刷）
  function noteTpsProgress(t) {
    if (!t.paneEl.isConnected) { return; }
    const now = Date.now();
    if (now - tpsSyncAt >= 250) { tpsSyncAt = now; if (activeId === t.id) { syncStatus(); } updatePaneHeads(); }
  }
  function pctTag(tab) {
    if (!tab || typeof tab.percent !== "number") { return ""; }
    const cls = tab.percent >= 90 ? " err" : (tab.percent >= 70 ? " warn" : "");
    return '<span class="st-pct' + cls + '">' + tab.percent.toFixed(1) + '%</span>';
  }
  // 用流式 delta 估算生成速度：CJK 字符按 1 token/字，其余约 4 字符/token
  function estTokens(text) {
    if (!text) { return 0; }
    let cjk = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0x3000 && c <= 0x9fff) { cjk++; }
    }
    return cjk + (text.length - cjk) / 4;
  }
  // 流式中返回实时均值，空闲时返回上一轮的最终均值
  function currentTps(tab) {
    if (!tab) { return undefined; }
    if (tab.streaming && tab.tpsStart > 0 && tab.tpsTokens > 0) {
      const secs = (Date.now() - tab.tpsStart) / 1000;
      return secs > 0.3 ? (tab.tpsTokens / secs) : undefined;
    }
    return tab.tps;
  }
  function statusTags(tab) {
    const parts = [];
    const mp = modelPartFor(tab);
    if (mp) { parts.push('<span class="st-model">' + mp + (tab.thinkingLevel ? "/" + tab.thinkingLevel : "") + '</span>'); }
    const pct = pctTag(tab);
    if (pct) { parts.push(pct); }
    const tps = currentTps(tab);
    if (typeof tps === "number") { parts.push('<span class="st-tps">' + tps.toFixed(1) + ' t/s</span>'); }
    return parts;
  }
  // 状态栏已全部下沉到每个 panel 底部（.pane-status）；此别名保留既有调用点。
  function syncStatus() { syncPaneStatuses(); }

  /** 附件预览：随 tab 级草稿（图片 / 折叠文本块与输入文字同层）。 */
  function renderAttachmentsFor() {
    const d = draftOfTab();
    imgPreviewEl.innerHTML = "";
    (d.images || []).forEach((img, idx) => {
      const wrap = document.createElement("div"); wrap.className = "img-thumb";
      const el = document.createElement("img"); el.src = "data:" + img.mimeType + ";base64," + img.data; wrap.appendChild(el);
      const rm = document.createElement("span"); rm.className = "rm"; rm.innerHTML = ICONS.close; rm.title = "移除";
      rm.addEventListener("click", () => { d.images.splice(idx, 1); renderAttachmentsFor(); });
      wrap.appendChild(rm); imgPreviewEl.appendChild(wrap);
    });
    (d.textBlocks || []).forEach((blk, idx) => {
      const card = document.createElement("div"); card.className = "text-block";
      const head = document.createElement("div"); head.className = "tb-head";
      const caret = document.createElement("span"); caret.className = "tb-caret"; caret.innerHTML = CHEVRON_SVG;
      const title = document.createElement("span"); title.className = "tb-title"; title.title = blk.title || "";
      const titleText = blk.title || ("粘贴文本 · " + blk.lines + " 行 · " + blk.chars + " 字符");
      title.innerHTML = ICONS.clippy + '<span>' + escHtml(titleText) + '</span>';
      head.appendChild(caret); head.appendChild(title);
      const rm = document.createElement("span"); rm.className = "tb-rm"; rm.innerHTML = ICONS.close; rm.title = "移除";
      rm.addEventListener("click", () => { d.textBlocks.splice(idx, 1); renderAttachmentsFor(); });
      const body = document.createElement("div"); body.className = "tb-body";
      const previewLines = blk.text.split("\n").slice(0, 400);
      body.textContent = previewLines.join("\n") + (blk.lines > 400 ? "\n…（预览截断，完整内容随发送提交）" : "");
      head.addEventListener("click", () => card.classList.toggle("expanded"));
      card.appendChild(head); card.appendChild(body); card.appendChild(rm);
      imgPreviewEl.appendChild(card);
    });
  }

  function draftOfTab() {
    if (!tabDrafts.has(activeTabId)) {
      tabDrafts.set(activeTabId, { text: "", selStart: 0, selEnd: 0, height: INPUT_MIN_HEIGHT, images: [], textBlocks: [] });
    }
    const d = tabDrafts.get(activeTabId);
    if (!Array.isArray(d.images)) { d.images = []; }
    if (!Array.isArray(d.textBlocks)) { d.textBlocks = []; }
    return d;
  }
  function saveInputState() {
    const d = draftOfTab();
    d.text = inputEl.value;
    d.selStart = inputEl.selectionStart;
    d.selEnd = inputEl.selectionEnd;
    d.height = parseInt(inputEl.style.height, 10) || INPUT_MIN_HEIGHT;
  }
  /**
   * 页面刚打开那一两秒还没有 tab，输入区里的字记在"没有 tab"那份草稿（键是 null）下。
   * 第一个 tab 出现时要把它搬过去：不然切到新 tab 会加载空草稿，把刚打的字冲掉
   * （表现为"打开界面马上打字，字自己没了"）。输入框里的实时内容以输入框为准，
   * 附件（粘的图、折叠文本块）在草稿里。
   */
  function carryComposerToTab(tabId) {
    const pending = tabDrafts.get(null);
    tabDrafts.set(tabId, {
      text: inputEl.value,
      selStart: inputEl.selectionStart,
      selEnd: inputEl.selectionEnd,
      height: parseInt(inputEl.style.height, 10) || INPUT_MIN_HEIGHT,
      images: (pending && pending.images) || [],
      textBlocks: (pending && pending.textBlocks) || [],
    });
    tabDrafts.delete(null);
  }
  function restoreInputState() {
    const d = draftOfTab();
    inputEl.value = d.text || "";
    inputEl.style.height = (d.height || INPUT_MIN_HEIGHT) + "px";
    try {
      inputEl.setSelectionRange(d.selStart || 0, d.selEnd || 0);
    } catch { /* ignore */ }
    renderAttachmentsFor();
    hideFileMenu();
  }

  function reflectTabUI() {
    const tab = activeTab();
    if (!tab) { return; }
    updateSendState();
    syncStatus();
    renderQueueBar(tab);
    syncJumpBottom(tab);
  }

  // ==================== tab 切换（容器） ====================
  // 触屏设备（手机/平板）上切 tab 不要自动聚焦输入框：程序聚焦会把输入法拉起来，
  // 键盘挡住半屏。电脑上保持原行为：切完 tab 焦点落在输入框，直接能打字。
  const IS_TOUCH_DEVICE = (function () {
    try { return window.matchMedia("(hover: none) and (pointer: coarse)").matches; }
    catch { return false; }
  })();
  function activateTabView(id) {
    if (!tabViews.has(id) || activeTabId === id) { return; }
    hideTagTip();
    if (activeTabId !== null) { saveInputState(); } else { carryComposerToTab(id); }
    activeTabId = id;
    const tv = tabViews.get(id);
    activeId = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
      ? tv.focusPanelId
      : (leavesOf(tv.root)[0] || null);
    renderLayout();
    restoreInputState();
    reflectTabUI();
    renderTabBar();
    if (!IS_TOUCH_DEVICE) { inputEl.focus(); }
    // 切到别的 tab：排在"还没有 tab"名下的消息现在有主了，能发就发
    flushPendingSend();
  }

  // ==================== tab 栏渲染（容器） ====================
  let tabBarSig = "";      // 内容签名：不变则跳过重建（流式期间 tabList 每 48ms 一推）
  let tabBarDirty = false; // 拖拽中跳过重建，dragend 后补一次
  /** 子会话（taba）的情况说明：鼠标悬到 tab 上那个标记时显示。 */
  function tabaTip(info) {
    if (!info) { return ""; }
    if (info.role === "child") {
      const from = info.parentName ? ("由「" + info.parentName + "」派来") : "已变成独立会话";
      const lines = ["子会话：" + (info.name || ""), from, "状态：" + (info.stateText || info.state || "")];
      if (info.modelLabel) { lines.push("模型：" + info.modelLabel); }
      if (info.deliveries > 0) { lines.push("结果已交回 " + info.deliveries + " 次"); }
      lines.push("在列表里右键它，可以把结果交回去、或改成独立会话。");
      return lines.join("\n");
    }
    const kids = info.children || [];
    const lines = ["这个会话派出去 " + kids.length + " 个子会话："];
    kids.forEach((k) => { lines.push("- " + k.name + "（" + (k.stateText || k.state) + "）"); });
    lines.push("点旁边的「子会话」标签可以列出并切过去。");
    return lines.join("\n");
  }
  /** 子会话状态的签名：变了才重建 tab 条（用时不进签名，否则每推一次都重建）。 */
  function tabaSig(info) {
    if (!info) { return ""; }
    if (info.role === "child") { return "c:" + (info.state || "") + ":" + (info.deliveries || 0) + ":" + (info.name || ""); }
    return "p:" + (info.children || []).map((k) => k.id + (k.state || "")).join(",");
  }
  // ---- 派子会话（taba）：子会话收进父 tab 后面的一张“子会话”标签 ----
  /** 是不是收进折叠标签的子会话：是子会话且派活的 tab 还在（变独立的、父关掉的不算，回标签栏当普通 tab）。 */
  function isStackedChildTab(tv) {
    return !!(tv && tv.taba && tv.taba.role === "child" && tv.taba.parentName && tv.taba.parentTabId);
  }
  /** 把收进折叠标签的子会话按父 tab 分组（父 tab id → 子会话数组，保持 tabList 顺序）。 */
  function stackedChildrenByParent() {
    const byParent = new Map();
    tabViews.forEach((tv) => {
      if (!isStackedChildTab(tv)) { return; }
      const list = byParent.get(tv.taba.parentTabId);
      if (list) { list.push(tv); } else { byParent.set(tv.taba.parentTabId, [tv]); }
    });
    return byParent;
  }
  /** 折叠标签：平时显示「子会话」，正在看某个子会话时显示它的名字；点开贴着标签的小列表。样式跟普通 tab 一致。 */
  function buildStackTab(parentTv, kids) {
    const el = document.createElement("div");
    el.className = "chat-tab taba-stack";
    el.dataset.stackFor = parentTv.id;
    const activeChild = kids.find((k) => k.id === activeTabId);
    if (activeChild) { el.classList.add("active"); }
    if (activeChild && activeChild.streaming) { el.classList.add("streaming"); }
    else if (activeChild && activeChild.loading) { el.classList.add("loading"); }
    const spinner = document.createElement("span"); spinner.className = "ct-spinner"; el.appendChild(spinner);
      const mark = document.createElement("span"); mark.className = "ts-mark"; mark.innerHTML = ICONS["git-branch"]; el.appendChild(mark);
    const title = document.createElement("span"); title.className = "ct-title";
    title.textContent = activeChild ? activeChild.name : "子会话";
    title.title = activeChild
      ? (tabaTip(activeChild.taba) || activeChild.name)
      : (tabaTip(parentTv.taba) || "这个会话派出去的子会话");
    el.appendChild(title);
    // 蓝色呼吸的小标：数字是还在跑的子会话个数；没有在跑的就不显示
    const running = kids.filter((k) => k.taba && (k.taba.state === "starting" || k.taba.state === "running")).length;
    if (running > 0) {
      const count = document.createElement("span");
      count.className = "ct-taba ct-taba-count running";
      count.textContent = String(running);
      el.appendChild(count);
    }
    el.addEventListener("click", () => {
      // 刚点标签把列表收起来了：这一次点击别又把它弹开（收起 / 弹开的开关）
      if (stackToggleGuard && stackToggleGuard.for === parentTv.id && Date.now() - stackToggleGuard.at < 350) {
        stackToggleGuard = null;
        return;
      }
      stackToggleGuard = null;
      if (stackMenu) { hideStackMenu(); return; }
      openStackMenu(el, parentTv.id, kids);
    });
    return el;
  }
  // ---- 折叠标签的小列表：贴着标签出（不是居中大浮层）----
  let stackMenu = null;          // { menu, parentTabId, closer, keyHandler }
  let stackToggleGuard = null;   // 刚点标签收起列表时的开关保护
  function hideStackMenu() {
    if (!stackMenu) { return; }
    document.removeEventListener("mousedown", stackMenu.closer, true);
    document.removeEventListener("keydown", stackMenu.keyHandler, true);
    stackMenu.menu.remove();
    stackMenu = null;
  }
  /** 行首的状态小点：跟 tab 上那颗呼吸点同一画法——只有还在跑的才显示（蓝点呼吸），
     跑完就消失；出错的显示红点。 */
  function stateDot(taba) {
    const st = taba ? taba.state : "";
    if (st === "starting" || st === "running") { return " running"; }
    if (st === "error") { return " error"; }
    return "";
  }
  function openStackMenu(anchorEl, parentTabId, kids) {
    hidePaneMenu();
    hideStackMenu();
    const menu = document.createElement("div");
    menu.className = "pane-menu stack-menu";
    kids.forEach((k) => {
      const row = document.createElement("div");
      row.className = "pm-item sm-row" + (activeTabId === k.id ? " sm-current" : "");
      const dot = document.createElement("span");
      dot.className = "sm-dot" + stateDot(k.taba);
      row.appendChild(dot);
      const label = document.createElement("span");
      label.className = "sm-name";
      label.textContent = k.name;
      label.title = tabaTip(k.taba) || k.name;
      row.appendChild(label);
      const x = document.createElement("span");
      x.className = "sm-close";
      x.title = "关闭这个子会话";
      x.innerHTML = PH_CLOSE_SVG;
      // 只关不切：别让这一下冒泡成“切过去”
      x.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "closeTab", tabId: k.id }); });
      row.appendChild(x);
      row.addEventListener("click", () => { hideStackMenu(); vscode.postMessage({ type: "switchTab", tabId: k.id }); });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    // 默认贴在标签正下方；快贴到屏幕边就收进来
    const r = anchorEl.getBoundingClientRect();
    menu.style.left = "0px";
    menu.style.top = "0px";
    const mr = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mr.width - 8)) + "px";
    menu.style.top = Math.min(r.bottom + 3, window.innerHeight - mr.height - 8) + "px";
    const closer = (ev) => {
      if (stackMenu && !stackMenu.menu.contains(ev.target)) {
        // 行右键弹出的操作菜单开着时，点它不算点在外面：下拉框要留着
        if (paneMenuEl && paneMenuEl.contains(ev.target)) { return; }
        // 点在标签自己身上：记一笔，让随后的 click 把它当成“收起”而不是“又弹开”
        if (anchorEl.contains(ev.target)) { stackToggleGuard = { at: Date.now(), for: parentTabId }; }
        hideStackMenu();
      }
    };
    const keyHandler = (ev) => {
      if (ev.key !== "Escape") { return; }
      // 有操作菜单先收它，再按一次才收下拉框
      if (paneMenuEl) { hidePaneMenu(); return; }
      hideStackMenu();
    };
    stackMenu = { menu, parentTabId, closer, keyHandler };
    document.addEventListener("mousedown", closer, true);
    document.addEventListener("keydown", keyHandler, true);
  }
  /** 小列表开着时跟着 tabList 刷新：子会话增减 / 状态变化都能跟上；父 tab 没了就整个收起。 */
  function refreshStackMenu() {
    const kids = stackedChildrenByParent().get(stackMenu.parentTabId);
    const anchor = tabBarInner.querySelector('.chat-tab.taba-stack[data-stack-for="' + stackMenu.parentTabId + '"]');
    if (!anchor || !kids || kids.length === 0) { hideStackMenu(); return; }
    openStackMenu(anchor, stackMenu.parentTabId, kids);
  }

  /** 上次已经滚到位的活跃 tab id（写在 renderTabBar 前头：免得初始化期间被调用时踩到未初始化） */
  let tabBarRevealedActive = null;
  function renderTabBar() {
    if (draggingPanelId) { tabBarDirty = true; return; }
    const byParent = stackedChildrenByParent();
    const sig = Array.from(tabViews.values())
      .filter((tv) => !isStackedChildTab(tv))
      .map((tv) =>
        tv.id + ":" + tv.name + ":" + (activeTabId === tv.id ? 1 : 0) + ":" + (tv.streaming ? 1 : 0) + ":" + (tv.loading ? 1 : 0) + ":" + tabaSig(tv.taba)
      )
      .concat(Array.from(byParent.entries()).map(([pid, kids]) =>
        "s:" + pid + ":" + kids.map((k) =>
          k.id + ":" + (activeTabId === k.id ? 1 : 0) + ":" + (k.streaming ? 1 : 0) + ":" + (k.loading ? 1 : 0) + ":" + tabaSig(k.taba)
        ).join(",")
      ))
      .join("|");
    if (sig === tabBarSig) { return; }
    tabBarSig = sig;
    // 重建会把滚动位置清零：tab 多了以后，流式期间名字一变就跳回最左边，后面的 tab 根本够不着。
    // 所以先记住、重建完再放回去。
    const keepScroll = tabBarInner.scrollLeft;
    tabBarInner.innerHTML = "";
    tabViews.forEach((tv) => {
      // 子会话（taba）收进父会话后面的折叠标签，不单独占位
      if (isStackedChildTab(tv)) { return; }
      const panelIds = leavesOf(tv.root);
      const single = panelIds.length === 1;
      const el = document.createElement("div");
      el.className = "chat-tab" + (activeTabId === tv.id ? " active" : "") + (tv.streaming ? " streaming" : "") + (tv.loading ? " loading" : "");
      el.dataset.tabId = tv.id;
      const spinner = document.createElement("span"); spinner.className = "ct-spinner"; el.appendChild(spinner);
      const title = document.createElement("span"); title.className = "ct-title"; title.textContent = tv.name; title.title = tv.name; el.appendChild(title);
      const close = document.createElement("span"); close.className = "ct-close"; close.title = "关闭 tab（内部 panel 全部关闭）";
      // 用 SVG 画叉：文本 “×” 在 Segoe UI 等字体下 ink 偏上，flex 居中无法修正；
      // SVG 笔画由 viewBox 几何决定，天然居中（与 VS Code 自带关闭图标同法）。
      close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
      close.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "closeTab", tabId: tv.id }); });
      el.appendChild(close);
      el.addEventListener("click", () => { vscode.postMessage({ type: "switchTab", tabId: tv.id }); });
      // panel 拖到该 tab 上 → 搬进该 tab
      el.addEventListener("dragover", (e) => {
        if (!draggingPanelId) { return; }
        e.preventDefault();
        e.stopPropagation();
        el.classList.add("drop-hint");
      });
      el.addEventListener("dragleave", (e) => {
        if (el.contains(e.relatedTarget)) { return; }
        el.classList.remove("drop-hint");
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drop-hint");
        if (!draggingPanelId) { return; }
        vscode.postMessage({ type: "movePanel", panelId: draggingPanelId, targetTabId: tv.id });
      });
      // 单 panel tab：tab 条目就是该 panel 的身份 —— 可直接拖到别的 tab 上合并过去
      if (single) {
        el.draggable = true;
        title.title = tv.name + "（拖到别的 tab 上合并过去）";
        el.addEventListener("dragstart", (e) => {
          draggingPanelId = panelIds[0];
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", panelIds[0]); } catch { /* ignore */ }
          document.body.classList.add("panel-dragging");
        });
        el.addEventListener("dragend", () => {
          draggingPanelId = null;
          document.body.classList.remove("panel-dragging");
          clearAllDropHints();
          if (tabBarDirty) { tabBarDirty = false; tabBarSig = ""; renderTabBar(); }
        });
      }      tabBarInner.appendChild(el);
      // 派了活的主 tab：后面跟一张「子会话」标签，把它的子会话收进去
      const kids = byParent.get(tv.id);
      if (kids && kids.length > 0) { tabBarInner.appendChild(buildStackTab(tv, kids)); }
    });
    tabBarInner.scrollLeft = keepScroll;
    // 换了活跃 tab（点开一个在屏幕外的）要滚过去；同一个 tab 反复重建时不动，
    // 免得用户自己滚到别处看别的 tab 时，视图被拽回来。
    if (activeTabId !== tabBarRevealedActive) {
      tabBarRevealedActive = activeTabId;
      revealTabInBar(activeTabId);
    }
    // 小列表开着时跟着 tabList 刷新（子会话增减 / 状态变化；父 tab 没了就收起）
    if (stackMenu) { refreshStackMenu(); }
  }

  /** 让某个 tab 在滑动条里露出来：看不见就滚过去，已经看得见就不动。 */
  function revealTabInBar(tabId) {
    if (!tabId) { return; }
    let el = tabBarInner.querySelector('.chat-tab[data-tab-id="' + tabId + '"]');
    if (!el) {
      // 折进折叠标签里的子会话：露出它父会话后面那个标签
      const tv = tabViews.get(tabId);
      if (tv && isStackedChildTab(tv)) {
        el = tabBarInner.querySelector('.chat-tab.taba-stack[data-stack-for="' + tv.taba.parentTabId + '"]');
      }
    }
    if (!el) { return; }
    const box = tabBarInner.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || box.width <= 0) { return; }
    if (r.right > box.right) { tabBarInner.scrollLeft += (r.right - box.right) + 8; }
    else if (r.left < box.left) { tabBarInner.scrollLeft -= (box.left - r.left) + 8; }
  }

  // ==================== 布局树渲染（tab 内的 panel 网格 / 拖拽） ====================
  const PH_CLOSE_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';

  /** 布局树叶子（panel id）深度优先序。 */
  function leavesOf(node) {
    if (!node) { return []; }
    if (node.kind === "panel") { return [node.panelId]; }
    return (node.children || []).flatMap(leavesOf);
  }

  /** 查 panel 所属的 tab id（不在任何 tab 中返回 null）。 */
  function panelTabOf(panelId) {
    for (const tv of tabViews.values()) {
      if (leavesOf(tv.root).includes(panelId)) { return tv.id; }
    }
    return null;
  }

  /** pane-head：创建一次常驻（tab 内 ≥2 个 panel 时由 CSS 显示）。 */
  function ensurePaneHead(tab) {
    if (!tab || tab.paneEl.querySelector(".pane-head")) { return; }
    const head = document.createElement("div");
    head.className = "pane-head";
    head.draggable = true;
    head.title = "拖动移动 panel · 双击最大化/还原";
    const dot = document.createElement("span"); dot.className = "ph-dot";
    const title = document.createElement("span");
    title.className = "ph-title";
    title.textContent = tab.title || "对话";
    const close = document.createElement("span");
    close.className = "ph-close";
    close.title = "关闭 panel（杀进程）";
    close.innerHTML = PH_CLOSE_SVG;
    close.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "closePanel", panelId: tab.id }); });
    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(close);
    // 同 statusbar：拦 mousedown 冒泡，避免 leaf 抢焦点重建 DOM 导致子元素 click 丢失；
    // 点击头部自身仍完成聚焦（关闭按钮有 stopPropagation 不受影响）。
    head.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeId !== tab.id) { focusPanelLocal(tab.id); }
    });
    head.addEventListener("dblclick", (e) => { e.stopPropagation(); toggleMaximize(tab.id); });
    head.addEventListener("dragstart", (e) => {
      draggingPanelId = tab.id;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", tab.id); } catch { /* ignore */ }
      document.body.classList.add("panel-dragging");
    });
    head.addEventListener("dragend", () => {
      draggingPanelId = null;
      document.body.classList.remove("panel-dragging");
      clearAllDropHints();
      if (tabBarDirty) { tabBarDirty = false; tabBarSig = ""; renderTabBar(); }
    });
    tab.paneEl.insertBefore(head, tab.paneEl.firstChild);
  }

  /** 刷新各 pane 头部（标题 / 流式灯）+ 每 panel 底部状态栏。 */
  function updatePaneHeads() {
    tabs.forEach((t) => {
      const head = t.paneEl.querySelector(".pane-head");
      if (!head) { return; }
      head.classList.toggle("ph-streaming", !!(t.streaming || t.loading));
      const titleEl = head.querySelector(".ph-title");
      if (titleEl) { titleEl.textContent = t.title || "对话"; titleEl.title = t.title || ""; }
    });
    syncPaneStatuses();
  }

  /** 单个 panel 底部状态栏的 HTML。 */
  function paneStatusHtml(t) {
    if (!t) { return ""; }
    if (t.loading) { return '<span class="st-text">加载中…</span>'; }
    if (!t.piReady) { return '<span class="st-text">等待 pi 启动…</span>'; }
    const tags = statusTags(t);
    if (t.streaming) {
      // 生成中只留打点动画和模型 / 进度 / 速度标签；状态词（处理中 / 思考中 / 执行工具）
      // 与 “Esc 中止” 提示已按需求去掉，中止入口是 Esc 键与停止生成图标。
      return '<span class="typing"><span></span><span></span><span></span></span> ' +
        (tags.length ? tags.join(" · ") : "");
    }
    if (!tags.length) { return '<span class="st-text">未配置模型（点击选择）</span>'; }
    return tags.join(" · ");
  }

  /** 状态栏结构签名：签名不变时原位更新文字，避免重建 innerHTML 导致 .typing 动画重启。 */
  function statusSig(t) {
    if (t.loading) { return "loading"; }
    if (!t.piReady) { return "wait"; }
    const pctCls = (typeof t.percent === "number")
      ? (t.percent >= 90 ? "err" : (t.percent >= 70 ? "warn" : "ok"))
      : "";
    const hasTps = typeof currentTps(t) === "number" ? "t" : "";
    return [(t.streaming ? "s" : "i"), modelPartFor(t) ? "m" : "", pctCls, hasTps].join("|");
  }
  /** 签名相同时只替换数字文本，不动 .typing 等动画节点。 */
  function updateStatusInPlace(el, t) {
    const m = el.querySelector(".st-model");
    if (m) { m.textContent = modelPartFor(t) + (t.thinkingLevel ? "/" + t.thinkingLevel : ""); }
    if (typeof t.percent === "number") {
      const p = el.querySelector(".st-pct");
      if (p) {
        p.textContent = t.percent.toFixed(1) + "%";
        p.className = "st-pct" + (t.percent >= 90 ? " err" : (t.percent >= 70 ? " warn" : ""));
      }
    }
    const tps = currentTps(t);
    if (typeof tps === "number") {
      const s = el.querySelector(".st-tps");
      if (s) { s.textContent = tps.toFixed(1) + " t/s"; }
    }
  }

  /** 刷新所有 panel 的底部状态栏内容与焦点高亮。 */
  function syncPaneStatuses() {
    tabs.forEach((t) => {
      const el = t.paneEl.parentElement
        ? t.paneEl.parentElement.querySelector(":scope > .pane-status")
        : null;
      if (!el) { return; }
      const sig = statusSig(t);
      if (el._sig === sig) {
        updateStatusInPlace(el, t);   // 保留 .typing 动画节点，只换变化文字
      } else {
        el._sig = sig;
        el.innerHTML = paneStatusHtml(t);
      }
      el.classList.toggle("ps-focus", activeId === t.id);
      const mp = modelPartFor(t);
      el.title = "当前: " + (mp || "未配置") + (t.thinkingLevel ? (" · 思考 " + t.thinkingLevel) : "") + "（点击切换模型）";
    });
  }

  // ---- pane-head / tab chip 右键菜单 ----
  let paneMenuEl = null;
  function hidePaneMenu() {
    if (!paneMenuEl) { return; }
    if (paneMenuEl._closer) { document.removeEventListener("mousedown", paneMenuEl._closer, true); }
    paneMenuEl.remove();
    paneMenuEl = null;
  }
  // ---- 布局 DOM ----
  /** 拖拽悬停区判定：边缘 28% 为上下左右，中心为替换。返回 zone 并高亮。 */
  function zoneFromEvent(leaf, e) {
    const r = leaf.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    const edge = 0.28;
    const zone = y < edge ? "top" : (y > 1 - edge ? "bottom" : (x < edge ? "left" : (x > 1 - edge ? "right" : "center")));
    leaf.querySelectorAll(".dz").forEach((d) => d.classList.toggle("on", d.dataset.zone === zone));
    return zone;
  }
  function clearAllDropHints() {
    document.querySelectorAll(".layout-leaf.drop-hover").forEach((el) => el.classList.remove("drop-hover", "drop-merge"));
    document.querySelectorAll(".dz.on").forEach((el) => el.classList.remove("on"));
    document.querySelectorAll(".chat-tab.drop-hint").forEach((el) => el.classList.remove("drop-hint"));
    tabBarEl.classList.remove("drop-hint");
  }

  function buildLeafDom(panelId) {
    const t = tabs.get(panelId);
    const leaf = document.createElement("div");
    leaf.className = "layout-leaf";
    leaf.dataset.panelId = panelId;
    if (t) {
      leaf.appendChild(t.paneEl);
      // 每个 panel 自己的底部状态栏（多 panel 时显示；点击切换该 panel 模型）
      const stBar = document.createElement("div");
      stBar.className = "pane-status";
      // 拦掉 mousedown 冒泡：否则 leaf 的 mousedown 会先切焦点，
      // 焦点切换重建 statusbar DOM（mousedown↟click 之间目标节点被换掉），
      // 导致随后的 click 丢失，模型选择器弹不出来。聚焦改在 click 里自己做。
      stBar.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      stBar.addEventListener("click", (e) => {
        e.stopPropagation();
        if (activeId !== panelId) { focusPanelLocal(panelId); }
        // t0：点击↟弹出的往返计时（宿主随 picker 消息回显，renderPicker 里打日志）
        vscode.postMessage({ type: "pickModel", tabId: panelId, t0: performance.now() });
      });
      leaf.appendChild(stBar);
    }
    // 落点指示层（四个方位 + 中心替换）；跨 tab 拖动时改显示整格“合并”提示
    const ind = document.createElement("div");
    ind.className = "drop-indicator";
    const ZONE_MARKS = { left: ICONS["arrow-left"], right: ICONS["arrow-right"], top: ICONS["arrow-up"], bottom: ICONS["arrow-down"], center: ICONS.close };
    const ZONE_TITLES = { left: "插到左侧", right: "插到右侧", top: "插到上方", bottom: "插到下方", center: "替换此 panel" };
    ["left", "right", "top", "bottom", "center"].forEach((z) => {
      const d = document.createElement("div");
      d.className = "dz dz-" + z;
      d.dataset.zone = z;
      d.title = ZONE_TITLES[z];
      const mark = document.createElement("span");
      mark.className = "dz-mark";
      mark.innerHTML = ZONE_MARKS[z];
      d.appendChild(mark);
      ind.appendChild(d);
    });
    const mergeHint = document.createElement("div");
    mergeHint.className = "drop-merge-hint";
    mergeHint.innerHTML = ICONS["merge-into"] + '<span> 合并进此 tab</span>';
    ind.appendChild(mergeHint);
    leaf.appendChild(ind);
    leaf.addEventListener("dragover", (e) => {
      if (!draggingPanelId || draggingPanelId === panelId) { return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      leaf.classList.add("drop-hover");
      // 跨 tab 拖动：整格合并提示；同 tab 重排：四分方位热区
      const sameTab = panelTabOf(draggingPanelId) === panelTabOf(panelId);
      leaf.classList.toggle("drop-merge", !sameTab);
      if (sameTab) { zoneFromEvent(leaf, e); }
    });
    leaf.addEventListener("dragleave", (e) => {
      if (leaf.contains(e.relatedTarget)) { return; }
      leaf.classList.remove("drop-hover", "drop-merge");
      leaf.querySelectorAll(".dz.on").forEach((d) => d.classList.remove("on"));
    });
    leaf.addEventListener("drop", (e) => {
      e.preventDefault();
      leaf.classList.remove("drop-hover", "drop-merge");
      leaf.querySelectorAll(".dz.on").forEach((d) => d.classList.remove("on"));
      if (!draggingPanelId || draggingPanelId === panelId) { return; }
      const sameTab = panelTabOf(draggingPanelId) === panelTabOf(panelId);
      if (sameTab) {
        const zone = zoneFromEvent(leaf, e);
        vscode.postMessage({ type: "movePanel", panelId: draggingPanelId, targetPanelId: panelId, zone });
      } else {
        const targetTabId = panelTabOf(panelId);
        if (targetTabId) {
          vscode.postMessage({ type: "movePanel", panelId: draggingPanelId, targetTabId });
        }
      }
    });
    leaf.addEventListener("mousedown", () => {
      if (activeId !== panelId) { focusPanelLocal(panelId); }
    });
    return leaf;
  }

  function buildNodeDom(node) {
    if (node.kind === "panel") { return buildLeafDom(node.panelId); }
    const el = document.createElement("div");
    el.className = "layout-split layout-" + (node.orientation === "v" ? "v" : "h");
    (node.children || []).forEach((c) => el.appendChild(buildNodeDom(c)));
    return el;
  }

  /** 布局结构签名：只看形态（树结构 + 焦点 + 最大化），不含 streaming/activity 等易变字段。 */
  function structSig(node) {
    if (!node) { return ""; }
    if (node.kind === "panel") { return "P(" + node.panelId + ")"; }
    return (node.orientation === "v" ? "V[" : "H[") + (node.children || []).map(structSig).join(",") + "]";
  }
  function layoutSignature() {
    const tv = tabViews.get(activeTabId);
    if (!tv) { return ""; }
    // 注意：焦点（focusPanelId）不入签名 —— 焦点变化只刷 focus 类/状态栏，不该重建布局
    return activeTabId + "|" + structSig(tv.root) + "|" + (maximized.get(activeTabId) || "");
  }

  /** 重建当前 tab 的布局 DOM（挂载到 #messages）。按缓存恢复各 pane 滚动位置。 */
  function renderLayout() {
    document.querySelectorAll("#messages .layout-root").forEach((el) => el.remove());
    const tv = tabViews.get(activeTabId);
    if (!tv) { return; }
    layoutSig = layoutSignature();
    const leaves = leavesOf(tv.root);
    const rootEl = document.createElement("div");
    rootEl.className = "layout-root" + (leaves.length > 1 ? " multi" : "");
    const max = maximized.get(activeTabId);
    if (max && leaves.length > 1 && leaves.includes(max)) {
      rootEl.classList.add("maximized");
    }
    rootEl.appendChild(buildNodeDom(tv.root));
    if (max && leaves.length > 1 && leaves.includes(max)) {
      rootEl.querySelectorAll(".layout-leaf").forEach((lf) => {
        if (lf.dataset.panelId === max) { lf.classList.add("maximized"); }
      });
    }
    messagesEl.appendChild(rootEl);
    // 恢复所有新挂载 pane 的滚动位置（优先 panel 状态缓存；贴底状态直接贴底）
    rootEl.querySelectorAll(".layout-leaf .tab-pane").forEach((p) => {
      const t = tabs.get(p.dataset.tabId);
      if (!t) { return; }
      if (t.stickToBottom) {
        t.programmaticScroll = true;
        p.scrollTop = p.scrollHeight;
        t.lastScrollTop = p.scrollTop;
      } else if (typeof t.lastScrollTop === "number") {
        p.scrollTop = t.lastScrollTop;
      }
    });
    // 重挂载会让 CSS 动画重播：剥掉历史气泡的入场动画，避免整窗“抖一下”
    rootEl.querySelectorAll(".msg-enter").forEach((el) => {
      el.classList.remove("msg-enter");
    });
    applyFocusClasses();
    updatePaneHeads();
  }

  function applyFocusClasses() {
    document.querySelectorAll("#messages .layout-leaf").forEach((lf) => {
      lf.classList.toggle("focus", lf.dataset.panelId === activeId);
    });
    syncPaneStatuses();
  }

  /** 焦点 panel（本地先切 + 后端同步）。输入框草稿按 tab 存，切焦点不动草稿。 */
  function focusPanelLocal(panelId) {
    if (activeId === panelId) { return; }
    const tv = tabViews.get(activeTabId);
    if (!tv || !leavesOf(tv.root).includes(panelId)) { return; }
    activeId = panelId;
    tv.focusPanelId = panelId;
    applyFocusClasses();
    reflectTabUI();
    renderAttachmentsFor();
    vscode.postMessage({ type: "focusPanel", panelId });
  }

  /** 双击 pane-head：最大化 / 还原（纯前端，树保留）。 */
  function toggleMaximize(panelId) {
    if (maximized.get(activeTabId) === panelId) { maximized.delete(activeTabId); }
    else { maximized.set(activeTabId, panelId); }
    renderLayout();
  }

  // ---- tab 栏作为 panel 拖拽落点（拖到某 tab 上 = 搬进去；空白 = 新 tab 带走）----
  tabBarEl.addEventListener("dragover", (e) => {
    if (!draggingPanelId) { return; }
    if (e.target.closest(".chat-tab")) { tabBarEl.classList.remove("drop-hint"); return; }
    e.preventDefault();
    tabBarEl.classList.add("drop-hint");
  });
  tabBarEl.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && tabBarEl.contains(e.relatedTarget)) { return; }
    tabBarEl.classList.remove("drop-hint");
  });
  // 滚轮落在 tab 栏上：竖着滚改成左右滚（原来什么反应都没有，只能拖那根细滑动条或者拉宽窗口）。
  // 没有溢出时不拦，页面照常滚。
  tabBarInner.addEventListener("wheel", (e) => {
    if (tabBarInner.scrollWidth - tabBarInner.clientWidth <= 2) { return; }
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) { return; }
    e.preventDefault();
    tabBarInner.scrollLeft += d;
  }, { passive: false });
  tabBarEl.addEventListener("drop", (e) => {
    tabBarEl.classList.remove("drop-hint");
    if (!draggingPanelId) { return; }
    if (e.target.closest(".chat-tab")) { return; } // tab chip 自己的 drop 处理
    e.preventDefault();
    vscode.postMessage({ type: "movePanel", panelId: draggingPanelId });
  });

  // ==================== 通用拾取器浮层（模型 / 历史）====================
  function hidePicker() {
    pickerOverlay.classList.add("hidden");
    pickerOverlay.classList.remove("pk-drawer");
    pickerBody.innerHTML = "";
    pickerSearch.value = "";
    pickerFooter.innerHTML = "";
    pickerFooter.classList.add("hidden");
    pickerFooter.classList.remove("pk-model-footer");
    pickerFooter.classList.remove("pk-history-footer");
    const leftoverClose = document.getElementById("pickerClose");
    if (leftoverClose) { leftoverClose.remove(); }
    pickerSearchWrap.classList.remove("hidden");
    pickerState = null;
  }
  /** pi /resume 列表的相对时间：now / 5m / 3h / 2d / 3w / 2mo / 1y。 */
  function pickerRelTime(ms) {
    if (!ms) { return ""; }
    const diffMin = Math.floor(Math.max(0, Date.now() - ms) / 60000);
    if (diffMin < 1) { return "now"; }
    if (diffMin < 60) { return diffMin + "m"; }
    const hr = Math.floor(diffMin / 60); if (hr < 24) { return hr + "h"; }
    const day = Math.floor(hr / 24); if (day < 7) { return day + "d"; }
    if (day < 30) { return Math.floor(day / 7) + "w"; }
    if (day < 365) { return Math.floor(day / 30) + "mo"; }
    return Math.floor(day / 365) + "y";
  }
  function pickerItemMatch(item, kind, q) {
    if (!q) { return true; }
    const hay = [];
    if (kind === "model") {
      hay.push(item.id || "", item.provider || "", item.name || "");
    } else if (kind === "options") {
      hay.push(item.label || "", item.desc || "");
    } else {
      // 没有专属排版的那几种（如浏览器界面里的选择列表）：按标题筛
      hay.push(item.label || "", item.title || "");
    }
    return hay.some((s) => s.toLowerCase().includes(q));
  }
  const THINKING_LABELS = {
    off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大",
  };
  const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  function thinkingLabel(level) { return THINKING_LABELS[level] || level || ""; }
  function modelKey(item) { return (item.provider || "") + "\u0000" + (item.id || ""); }
  function modelThinkingLevels(item) { return Array.isArray(item.thinkingLevels) ? item.thinkingLevels : []; }
  /** 模型价格（$/M tokens）：cost 存在且有有效费率时返回 { text, tip }。 */
  function modelCostInfo(item) {
    const c = item && item.cost;
    if (!c || typeof c !== "object") { return null; }
    const nIn = typeof c.input === "number" ? c.input : 0;
    const nOut = typeof c.output === "number" ? c.output : 0;
    if (!(nIn > 0) && !(nOut > 0)) { return null; }
    const text = "入 $" + nIn + " / 出 $" + nOut + "/M";
    const lines = ["输入：$" + nIn, "输出：$" + nOut];
    if (typeof c.cacheRead === "number" && c.cacheRead > 0) { lines.push("缓存读：$" + c.cacheRead); }
    if (typeof c.cacheWrite === "number" && c.cacheWrite > 0) { lines.push("缓存写：$" + c.cacheWrite); }
    return { text: text, tip: "每百万 tokens 价格\n" + lines.join("\n") };
  }
  function isCurrentModel(st, item) {
    return !!item && (modelKey(item) === st.current || item.current === true);
  }
  function currentModelItem(st) {
    return st.items.find((item) => isCurrentModel(st, item)) || null;
  }
  function currentThinkingLevel(st) {
    const item = currentModelItem(st);
    return item && item.reasoning ? (item.currentThinking || "medium") : "";
  }
  function defaultThinkingForModel(st, item) {
    if (!item || !item.reasoning) { return undefined; }
    const levels = modelThinkingLevels(item);
    if (levels.length === 0) { return undefined; }
    // 尽量保留当前档位；不支持时按 pi 的默认 medium 进行就近钳制。
    const current = currentThinkingLevel(st);
    if (current && levels.includes(current)) { return current; }
    const preferredIndex = THINKING_ORDER.indexOf("medium");
    for (let i = preferredIndex; i < THINKING_ORDER.length; i++) {
      if (levels.includes(THINKING_ORDER[i])) { return THINKING_ORDER[i]; }
    }
    for (let i = preferredIndex - 1; i >= 0; i--) {
      if (levels.includes(THINKING_ORDER[i])) { return THINKING_ORDER[i]; }
    }
    return levels[0];
  }
  function modelDraftChanged(st) {
    if (!st.draftModel) { return false; }
    if (!isCurrentModel(st, st.draftModel)) { return true; }
    const draftLevel = st.draftModel.reasoning ? (st.draftThinking || "medium") : "";
    return draftLevel !== currentThinkingLevel(st);
  }
  function selectModelIndex(st, idx, scroll) {
    const item = st.filtered[idx];
    if (!item) { return; }
    st.sel = idx;
    st.draftModel = item;
    st.draftThinking = defaultThinkingForModel(st, item);
    renderPickerItems();
    if (scroll) {
      const active = pickerBody.querySelector(".pk-model-item.active");
      if (active) { active.scrollIntoView({ block: "nearest" }); }
    }
  }
  function moveModelThinking(delta) {
    const st = pickerState;
    if (!st || st.kind !== "model" || !st.draftModel || !st.draftModel.reasoning) { return; }
    const levels = modelThinkingLevels(st.draftModel);
    if (levels.length === 0) { return; }
    let index = levels.indexOf(st.draftThinking);
    if (index < 0) { index = 0; }
    st.draftThinking = levels[(index + delta + levels.length) % levels.length];
    renderPickerItems();
  }
  function renderModelThinking(item, st, right) {
    if (st.draftModel !== item) { return; }
    right.classList.add("has-content");
    const label = document.createElement("div"); label.className = "pk-thinking-label"; label.textContent = "推理强度";
    right.appendChild(label);
    if (!item.reasoning) {
      const unsupported = document.createElement("div"); unsupported.className = "pk-thinking-unsupported"; unsupported.textContent = "不支持推理";
      right.appendChild(unsupported);
      return;
    }
    const levels = modelThinkingLevels(item);
    if (levels.length === 0) {
      const failed = document.createElement("div"); failed.className = "pk-thinking-unsupported"; failed.textContent = "无法获取设置";
      right.appendChild(failed);
      return;
    }
    const options = document.createElement("div"); options.className = "pk-thinking-options";
    levels.forEach((level) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pk-thinking-btn" + (level === st.draftThinking ? " on" : "");
      button.textContent = thinkingLabel(level);
      button.title = level;
      button.setAttribute("aria-pressed", level === st.draftThinking ? "true" : "false");
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        st.draftThinking = level;
        renderPickerItems();
      });
      options.appendChild(button);
    });
    right.appendChild(options);
  }
  function renderModelFooter(st) {
    pickerFooter.innerHTML = "";
    pickerFooter.classList.remove("hidden");
    pickerFooter.classList.add("pk-model-footer");
    const summary = document.createElement("div"); summary.className = "pk-footer-summary";
    if (!st.draftModel) {
      summary.textContent = "选择模型以查看推理设置";
    } else {
      const modelName = st.draftModel.name && st.draftModel.name !== st.draftModel.id
        ? st.draftModel.name + " · " + st.draftModel.id : st.draftModel.id;
      const levelText = st.draftModel.reasoning
        ? (st.draftThinking ? "推理 " + thinkingLabel(st.draftThinking) : "推理未选择")
        : "不支持推理";
      const costInfo = modelCostInfo(st.draftModel);
      summary.textContent = "待应用：" + modelName + " · " + levelText + (costInfo ? " · " + costInfo.text : "");
    }
    pickerFooter.appendChild(summary);
    const actions = document.createElement("div"); actions.className = "pk-footer-actions";
    const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => cancelPicker());
    actions.appendChild(cancelBtn);
    const confirmBtn = document.createElement("button"); confirmBtn.type = "button"; confirmBtn.className = "primary"; confirmBtn.textContent = "确认切换";
    const ready = !!st.draftModel && (!st.draftModel.reasoning || modelThinkingLevels(st.draftModel).length > 0);
    confirmBtn.disabled = !ready || !modelDraftChanged(st);
    confirmBtn.addEventListener("click", () => submitModelPicker());
    actions.appendChild(confirmBtn);
    pickerFooter.appendChild(actions);
  }
  function renderPickerItems() {
    const st = pickerState;
    if (!st) { return; }
    const q = (pickerSearch.value || "").toLowerCase().trim();
    st.filtered = st.items.filter((it) => pickerItemMatch(it, st.kind, q));
    if (st.kind === "model") {
      if (st.draftModel) {
        const draftIndex = st.filtered.indexOf(st.draftModel);
        if (draftIndex >= 0) {
          st.sel = draftIndex;
        } else {
          st.sel = -1;
          st.draftModel = null;
          st.draftThinking = undefined;
        }
      } else if (st.sel >= st.filtered.length) {
        st.sel = -1;
      }
    } else if (st.sel >= st.filtered.length) {
      st.sel = Math.max(0, st.filtered.length - 1);
    }
    pickerBody.innerHTML = "";
    if (st.filtered.length === 0) {
      const empty = document.createElement("div"); empty.className = "pk-empty";
      empty.textContent = q ? "没有匹配项。" : "列表为空。";
      pickerBody.appendChild(empty);
      if (st.kind === "history" && st.historyHasMore) { pickerBody.appendChild(buildHistoryLoadMoreBtn(st)); }
      if (st.kind === "model") { renderModelFooter(st); }
      return;
    }
    let lastSection = null;
    let lastModelProv = null;
    st.filtered.forEach((item, idx) => {
      if (st.kind === "model") {
        // provider 分组分隔线：host 已按 provider 排序，同 provider 项连续；
        // 标题带组内数量（随搜索过滤实时重算），无 provider 归入“其他”。
        if ((item.provider || "") !== lastModelProv) {
          lastModelProv = item.provider || "";
          const runCount = st.filtered.filter((x) => (x.provider || "") === lastModelProv).length;
          const sep = document.createElement("div"); sep.className = "pk-section pk-provider";
          sep.textContent = (item.provider || "其他") + " (" + runCount + ")";
          pickerBody.appendChild(sep);
        }
        const el = document.createElement("div");
        const isSelected = st.draftModel === item;
        el.className = "pk-item pk-model-item" + (isSelected ? " active" : "");
        if (item.current) { el.classList.add("current"); }
        if (isSelected && !isCurrentModel(st, item)) { el.classList.add("pending"); }

        const main = document.createElement("div"); main.className = "pk-model-main";
        const title = document.createElement("div"); title.className = "pk-title"; title.textContent = item.id || "(未命名模型)";
        if (item.current) { const badge = document.createElement("span"); badge.className = "pk-badge"; badge.textContent = "当前"; title.appendChild(badge); }
        if (isSelected && !isCurrentModel(st, item)) { const badge = document.createElement("span"); badge.className = "pk-badge pending-badge"; badge.textContent = "待应用"; title.appendChild(badge); }
        main.appendChild(title);
        const desc = (item.provider ? item.provider : "") + (item.name && item.name !== item.id ? (item.provider ? " · " : "") + item.name : "");
        if (desc) { const d = document.createElement("div"); d.className = "pk-desc"; d.textContent = desc; main.appendChild(d); }
        const details = [];
        if (item.contextWindow) { details.push("上下文 " + Math.round(item.contextWindow / 1000) + "K"); }
        const priceInfo = modelCostInfo(item);
        if (priceInfo) { details.push(priceInfo.text); }
        if (details.length) {
          const det = document.createElement("div"); det.className = "pk-detail";
          det.textContent = details.join(" · ");
          if (priceInfo) { det.title = priceInfo.tip; }
          main.appendChild(det);
        }
        const right = document.createElement("div"); right.className = "pk-model-thinking";
        renderModelThinking(item, st, right);
        el.appendChild(main); el.appendChild(right);
        el.addEventListener("click", () => selectModelIndex(st, idx, true));
        pickerBody.appendChild(el);
        return;
      }

      if (item.section && item.section !== lastSection) {
        lastSection = item.section;
        const sep = document.createElement("div"); sep.className = "pk-section"; sep.textContent = item.section;
        pickerBody.appendChild(sep);
      }
      const el = document.createElement("div");
      el.className = "pk-item" + (idx === st.sel ? " active" : "");
      if (st.kind === "history") {
        el.classList.add("pk-history");
        if (item.current) { el.classList.add("current"); }
        const main = document.createElement("div"); main.className = "pk-history-main";
        const title = document.createElement("span"); title.className = "pk-history-title"; title.textContent = item.title || "(无消息)";
        main.appendChild(title);
        const right = document.createElement("span"); right.className = "pk-history-right";
        const count = document.createElement("span"); count.className = "pk-history-count"; count.textContent = String(item.count ?? 0);
        const age = document.createElement("span"); age.className = "pk-history-age"; age.textContent = pickerRelTime(item.lastActivity);
        right.appendChild(count); right.appendChild(age);
        main.appendChild(right);
        el.appendChild(main);
        el.title = item.title || "";
      } else if (st.kind === "options") {
        const t = document.createElement("div"); t.className = "pk-title";
        const chk = document.createElement("span"); chk.className = "pk-check" + (item.check === true ? " on" : "");
        chk.innerHTML = item.check === true ? ICONS.check : "";
        t.appendChild(chk);
        t.appendChild(document.createTextNode(item.label || ""));
        el.appendChild(t);
        if (item.desc) { const d = document.createElement("div"); d.className = "pk-desc"; d.style.paddingLeft = "20px"; d.textContent = item.desc; el.appendChild(d); }
      }
      // 其他种类（没有专属排版的，如浏览器界面里问“选哪一项”）：直接渲染标题
      if (st.kind !== "history" && st.kind !== "options" && item.label) {
        const t = document.createElement("div"); t.className = "pk-title";
        t.textContent = String(item.label);
        el.appendChild(t);
      }
      el.addEventListener("mouseenter", () => { st.sel = idx; renderPickerActive(); });
      el.addEventListener("click", () => { confirmPicker(idx); });
      pickerBody.appendChild(el);
    });
    // history「加载更多」：列表底部追加按钮。
    if (st.kind === "history" && st.historyHasMore) {
      pickerBody.appendChild(buildHistoryLoadMoreBtn(st));
    }
    if (st.kind === "model") { renderModelFooter(st); }
  }
  function buildHistoryLoadMoreBtn(st) {
    const btn = document.createElement("button");
    btn.className = "pk-loadmore secondary";
    btn.textContent = st.historyLoading ? "加载中…" : "加载更多";
    btn.disabled = !!st.historyLoading;
    btn.addEventListener("click", () => {
      if (st.historyLoading) { return; }
      st.historyLoading = true;
      renderPickerItems();
      vscode.postMessage({ type: "historyLoadMore" });
    });
    return btn;
  }
  function renderPickerActive() {
    const st = pickerState; if (!st) { return; }
    const items = pickerBody.querySelectorAll(".pk-item");
    items.forEach((el, i) => el.classList.toggle("active", i === st.sel));
    const cur = items[st.sel];
    if (cur) { cur.scrollIntoView({ block: "nearest" }); }
  }
  function submitModelPicker() {
    const st = pickerState;
    if (!st || st.kind !== "model" || !st.draftModel) { return; }
    const ready = !st.draftModel.reasoning || modelThinkingLevels(st.draftModel).length > 0;
    if (!ready || !modelDraftChanged(st)) { return; }
    const payload = {
      provider: st.draftModel.provider || "",
      modelId: st.draftModel.id,
      thinkingLevel: st.draftThinking,
    };
    hidePicker();
    vscode.postMessage({ type: "pickerChoice", kind: "model", payload });
  }
  function confirmPicker(idx) {
    const st = pickerState; if (!st) { return; }
    if (st.kind === "model") { submitModelPicker(); return; }
    const item = st.filtered[idx];
    if (!item) { return; }
    const kind = st.kind;
    if (st.toggle || item.behavior === "toggle") {
      vscode.postMessage({ type: "pickerToggle", kind, action: item.action, value: item.value });
      return;
    }
    const payload = { file: item.file };
    hidePicker();
    vscode.postMessage({ type: "pickerChoice", kind, payload });
  }
  function cancelPicker() {
    const st = pickerState; if (!st) { return; }
    const kind = st.kind;
    hidePicker();
    vscode.postMessage({ type: "pickerCancel", kind });
  }
  function renderPicker(msg) {
    const kind = msg.kind;
    const toggle = !!msg.toggle;
    const searchable = msg.searchable !== false && !toggle;
    pickerState = {
      kind,
      items: Array.isArray(msg.items) ? msg.items : [],
      filtered: [],
      sel: kind === "model" ? -1 : 0,
      current: msg.current || null,
      draftModel: null,
      draftThinking: undefined,
      toggle,
      // history「加载更多」：宿主说还有没有下一批。
      historyHasMore: msg.hasMore === true,
      historyLoading: false,
    };
    const titleMap = { model: "切换模型", history: "会话历史", options: "显示选项" };
    pickerTitle.textContent = titleMap[kind] || (typeof msg.title === "string" && msg.title ? msg.title : "选择");
    pickerSearch.value = "";
    pickerSearchWrap.classList.toggle("hidden", !searchable);
    pickerFooter.classList.remove("pk-model-footer");
    pickerFooter.classList.remove("pk-history-footer");
    pickerFooter.innerHTML = "";
    if (kind === "model") {
      pickerFooter.classList.remove("hidden");
      // 预选当前模型为 draft（host 已把它排到列表第一位）：打开即高亮 +
      // 推理强度/footer 就绪；无改动时 Enter 提交被 no-op 保护拦掉。
      const cur = pickerState.items.find((it) => it.current);
      if (cur) {
        pickerState.draftModel = cur;
        pickerState.draftThinking = defaultThinkingForModel(pickerState, cur);
      }
    } else if (kind === "history") {
      // 历史会话面板：头部加一颗关闭按钮（面板占满整屏高，窄屏幕上遮罩只剩
      // 一条缝，点不到），底部留一行「设置」——点它先收起面板，再打开设置浮层。
      pickerFooter.classList.remove("hidden");
      pickerFooter.classList.add("pk-history-footer");
      const headerClose = document.createElement("button");
      headerClose.type = "button"; headerClose.id = "pickerClose";
      headerClose.title = "关闭 (Esc)"; headerClose.setAttribute("aria-label", "关闭");
      headerClose.innerHTML = ICONS.close;
      headerClose.addEventListener("click", () => cancelPicker());
      pickerHeader.appendChild(headerClose);
      const settingsBtn = document.createElement("button"); settingsBtn.type = "button";
      settingsBtn.className = "secondary"; settingsBtn.textContent = "⚙ 设置";
      settingsBtn.addEventListener("click", () => { cancelPicker(); openSettings(); });
      pickerFooter.appendChild(settingsBtn);
    } else if (toggle) {
      pickerFooter.classList.remove("hidden");
      const closeBtn = document.createElement("button"); closeBtn.className = "secondary"; closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", () => cancelPicker());
      pickerFooter.appendChild(closeBtn);
    } else {
      pickerFooter.classList.add("hidden");
    }
    // 历史会话从右侧滑进来（整屏高的面板）；其余拾取器照旧居中弹出
    pickerOverlay.classList.toggle("pk-drawer", kind === "history");
    renderPickerItems();
    pickerOverlay.classList.remove("hidden");
    // 计时：若宿主回显了 t0，输出点击 → picker 可见的往返耗时（多 panel 卡顿排查用）
    if (typeof msg.t0 === "number") {
      console.log("[pi] picker(" + kind + ") 点击→弹出: " + Math.round(performance.now() - msg.t0) + "ms");
    }
    if (searchable) { setTimeout(() => pickerSearch.focus(), 0); }
  }
  pickerOverlay.addEventListener("click", (e) => { if (e.target === pickerOverlay) { cancelPicker(); } });
  pickerSearch.addEventListener("input", () => {
    if (!pickerState) { return; }
    pickerState.sel = pickerState.kind === "model" ? -1 : 0;
    renderPickerItems();
  });
  document.addEventListener("keydown", (e) => {
    if (!pickerState || pickerOverlay.classList.contains("hidden")) { return; }
    const st = pickerState;
    if (st.kind === "model") {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (st.filtered.length) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          let next = st.sel < 0 ? (delta > 0 ? 0 : st.filtered.length - 1) : st.sel + delta;
          next = (next + st.filtered.length) % st.filtered.length;
          selectModelIndex(st, next, true);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        moveModelThinking(e.key === "ArrowRight" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        submitModelPicker();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelPicker();
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); if (st.filtered.length) { st.sel = (st.sel + 1) % st.filtered.length; renderPickerActive(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (st.filtered.length) { st.sel = (st.sel - 1 + st.filtered.length) % st.filtered.length; renderPickerActive(); } }
    else if (e.key === "Enter") { e.preventDefault(); confirmPicker(st.sel); }
    else if (e.key === "Escape") { e.preventDefault(); cancelPicker(); }
  });


  // ==================== @ 文件引用 ====================
  let fileMatches = [];
  let fileSel = 0;
  let atStart = -1;
  function hideFileMenu() { fileMenuEl.classList.add("hidden"); atStart = -1; }
  function maybeShowFileMenu() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { hideFileMenu(); return; }
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) { hideFileMenu(); return; }
    // @ 触发时若 # 会话菜单开着：重置其状态（两菜单共用同一个浮层节点）
    hashOpen = false; hashStart = -1;
    atStart = pos - m[2].length - 1;
    vscode.postMessage({ type: "listFiles" });
    filterFiles(m[2]);
  }
  function filterFiles(query) {
    const q = (query || "").toLowerCase();
    fileMatches = openFiles.filter((f) => f.label.toLowerCase().includes(q)).slice(0, 20);
    fileSel = 0;
    renderFileMenu();
  }
  function renderFileMenu() {
    if (fileMatches.length === 0) { fileMenuEl.classList.add("hidden"); return; }
    fileMenuEl.innerHTML = "";
    fileMatches.forEach((f, idx) => {
      const item = document.createElement("div"); item.className = "file-item" + (idx === fileSel ? " active" : "");
      const slash = f.label.lastIndexOf("/");
      if (slash >= 0) { const dir = document.createElement("span"); dir.className = "dir"; dir.textContent = f.label.slice(0, slash + 1); item.appendChild(dir); item.appendChild(document.createTextNode(f.label.slice(slash + 1))); }
      else { item.textContent = f.label; }
      item.addEventListener("mousedown", (e) => { e.preventDefault(); fileSel = idx; chooseFile(); });
      fileMenuEl.appendChild(item);
    });
    fileMenuEl.classList.remove("hidden");
  }
  function moveFileSel(delta) { if (fileMatches.length === 0) return; fileSel = (fileSel + delta + fileMatches.length) % fileMatches.length; renderFileMenu(); }
  function chooseFile() {
    const f = fileMatches[fileSel];
    if (!f || atStart < 0) { hideFileMenu(); return; }
    const pos = inputEl.selectionStart;
    const ref = "@" + f.label + " ";
    inputEl.value = inputEl.value.slice(0, atStart) + ref + inputEl.value.slice(pos);
    const newPos = atStart + ref.length;
    inputEl.selectionStart = inputEl.selectionEnd = newPos;
    hideFileMenu(); autoResize(); inputEl.focus();
  }

  // ==================== # 会话引用（获取其他 panel/tab 的上下文） ====================
  let hashMatches = [];   // [{kind:"tab"|"panel", id, label, sub}]
  let hashSel = 0;
  let hashStart = -1;     // # 触发字符在输入框的位置
  let hashOpen = false;
  let hashReqSeq = 0;
  // 宿主下发的全局目录：覆盖侧边栏和所有当前打开的编辑器 Pi Chat。
  let chatReferences = [];
  function hideHashMenu() { fileMenuEl.classList.add("hidden"); hashStart = -1; hashOpen = false; }
  function maybeShowHashMenu() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { hideHashMenu(); return; }
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/(^|\s)#([^\s#]*)$/);
    if (!m) { hideHashMenu(); return; }
    hashStart = pos - m[2].length - 1;
    hideFileMenu();
    hashOpen = true;
    filterHashMenu(m[2]);
  }

  /** # 引用候选由扩展统一下发，因而可跨侧边栏与编辑器工作区。 */
  function hashMenuItems() {
    return chatReferences;
  }

  function filterHashMenu(query) {
    const q = (query || "").toLowerCase();
    const all = hashMenuItems();
    if (!q) { hashMatches = all; }
    else {
      // tab 名命中 → 整组保留；否则只留自身命中的 panel 行，空组剔除
      const keptTabs = new Set();
      all.forEach((it) => {
        if (it.kind === "tab" && it.label.toLowerCase().includes(q)) { keptTabs.add(it.tabId); }
      });
      const kept = [];
      all.forEach((it) => {
        if (it.kind === "tab") {
          if (keptTabs.has(it.id)) { kept.push(it); }
        } else if (keptTabs.has(it.tabId) || it.label.toLowerCase().includes(q)) {
          kept.push(it);
          keptTabs.add(it.tabId);
        }
      });
      hashMatches = kept;
    }
    hashSel = 0;
    renderHashMenu();
  }

  function renderHashMenu() {
    if (!hashMatches.length) { fileMenuEl.classList.add("hidden"); return; }
    fileMenuEl.innerHTML = "";
    hashMatches.forEach((it, idx) => {
      const item = document.createElement("div");
      item.className = "file-item" + (idx === hashSel ? " active" : "") + (it.kind === "tab" ? " hash-tab-row" : "");
      const kindIcon = document.createElement("span"); kindIcon.className = "hash-kind";
      kindIcon.innerHTML = it.kind === "tab" ? ICONS.files : ICONS.comment;
      item.appendChild(kindIcon);
      item.appendChild(document.createTextNode(" " + it.label));
      if (it.sub) {
        const sub = document.createElement("span"); sub.className = "dir"; sub.textContent = "  " + it.sub;
        item.appendChild(sub);
      }
      item.addEventListener("mousedown", (e) => { e.preventDefault(); hashSel = idx; chooseHash(); });
      fileMenuEl.appendChild(item);
    });
    fileMenuEl.classList.remove("hidden");
  }
  function moveHashSel(delta) {
    if (!hashMatches.length) { return; }
    hashSel = (hashSel + delta + hashMatches.length) % hashMatches.length;
    renderHashMenu();
  }
  function chooseHash() {
    const it = hashMatches[hashSel];
    if (!it || hashStart < 0) { hideHashMenu(); return; }
    // 删掉 #查询 token（出处信息由卡片头部承载）
    const pos = inputEl.selectionStart;
    inputEl.value = inputEl.value.slice(0, hashStart) + inputEl.value.slice(pos);
    inputEl.selectionStart = inputEl.selectionEnd = hashStart;
    hideHashMenu(); autoResize(); inputEl.focus();
    hashReqSeq++;
    vscode.postMessage(it.kind === "tab"
      ? { type: "fetchChat", tabId: it.id, requestId: hashReqSeq }
      : { type: "fetchChat", panelId: it.id, requestId: hashReqSeq });
  }

  /** fetchChatResult：会话内容入草稿卡片（标题/体积由宿主算好）。 */
  function applyFetchChatResult(msg) {
    if (msg.requestId !== hashReqSeq) { return; }   // 过期 / 竞态结果丢弃
    if (!activeTab()) { return; }
    const d = draftOfTab();
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text) { return; }
    const lines = text.split("\n").length;
    d.textBlocks.push({ text, lines, chars: text.length, title: typeof msg.title === "string" ? msg.title : undefined });
    renderAttachmentsFor();
    inputEl.focus();
  }

  // ==================== / 命令菜单（技能 / 提示模板 / 扩展命令） ====================
  /** 宿主 get_commands 结果缓存：[{insert, name, description, source}]；
   *  宿主 pi 进程启动/刷新时会主动推 commandList 覆盖。 */
  let commandListCache = [];
  /** 上次向宿主要列表的时间：空结果时 5s 内不重复请求（避免每次敲 / 都打一次 RPC）。 */
  let commandListReqAt = 0;
  let slashMatches = [];
  let slashSel = 0;
  let slashOpen = false;
  function requestCommandList() {
    if (commandListCache.length > 0) { return; }
    const now = Date.now();
    if (commandListReqAt && now - commandListReqAt < 5000) { return; }
    commandListReqAt = now;
    vscode.postMessage({ type: "listCommands" });
  }
  function closeSlashMenu() { slashOpen = false; slashMatches = []; }
  function maybeShowSlashMenu() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { closeSlashMenu(); return; }
    // 输入整体是单个 / 开头的 token（命令 + 正在输入的名字）才弹菜单；
    // 敲了空格/其它内容就不再弹，交给用户继续写参数。
    const m = inputEl.value.match(/^\/(\S*)$/);
    if (!m) { closeSlashMenu(); return; }
    // 三个菜单共用同一个浮层节点：接管前重置兄弟菜单状态
    atStart = -1; hashOpen = false; hashStart = -1;
    slashOpen = true;
    requestCommandList();
    filterSlashMenu(m[1]);
  }
  function filterSlashMenu(query) {
    const q = (query || "").toLowerCase();
    slashMatches = commandListCache
      .filter((it) => !q || (it.name || "").toLowerCase().includes(q))
      .slice(0, 30);
    slashSel = 0;
    renderSlashMenu();
  }
  function renderSlashMenu() {
    if (!slashMatches.length) { fileMenuEl.classList.add("hidden"); return; }
    fileMenuEl.innerHTML = "";
    slashMatches.forEach((it, idx) => {
      const item = document.createElement("div");
      item.className = "file-item" + (idx === slashSel ? " active" : "");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = it.insert || ("/" + (it.name || ""));
      item.appendChild(nameSpan);
      if (it.source) {
        const badge = document.createElement("span");
        badge.className = "cmd-badge cmd-" + it.source;
        badge.textContent = it.source === "skill" ? "技能" : it.source === "prompt" ? "模板" : it.source === "extension" ? "命令" : "";
        item.appendChild(badge);
      }
      if (it.description) {
        const sub = document.createElement("span");
        sub.className = "dir";
        sub.textContent = "  " + it.description;
        item.appendChild(sub);
      }
      item.addEventListener("mousedown", (e) => { e.preventDefault(); slashSel = idx; chooseSlash(); });
      fileMenuEl.appendChild(item);
    });
    fileMenuEl.classList.remove("hidden");
  }
  function moveSlashSel(delta) {
    if (!slashMatches.length) { return; }
    slashSel = (slashSel + delta + slashMatches.length) % slashMatches.length;
    renderSlashMenu();
  }
  /** 选中候选：替换整个输入框内容为 "/name "（光标在末尾，继续敲参数）。 */
  function chooseSlash() {
    const it = slashMatches[slashSel];
    if (!it) { closeSlashMenu(); return; }
    inputEl.value = (it.insert || ("/" + (it.name || ""))) + " ";
    closeSlashMenu();
    fileMenuEl.classList.add("hidden");
    autoResize();
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
  }

  // ==================== 发送 ====================
  function autoResize() {
    if (inputEl.value.length > BIG_TEXT_CHARS) { inputEl.style.height = "640px"; return; }
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight - 12, INPUT_MIN_HEIGHT), 640) + "px";
  }
  function shouldFoldText(text) {
    if (typeof text !== "string" || !text) { return false; }
    if (text.length > BIG_TEXT_CHARS) { return true; }
    return countLines(text) > BIG_TEXT_LINES;
  }
  // ==================== 会话没就绪时按的回车 ====================
  // 刚打开界面的一两秒里，pi 进程还在起（tab.piReady 还是 false）。这时候按回车，
  // 以前是悄然丢掉：不发送，也不告诉你（字还留在输入框里，得像没事一样再按一次）。
  // 现在把这次回车记下来：字照旧留在输入框里，等会话就绪（piReady 变 true）自动补发一次。
  //
  // 为什么不让字离开输入框（比如先在对话里摆一条"排队中"的气泡）：那样得在 pi 回显时
  // 再把临时气泡收掉，还得保证两边不重不漏。字留在框里最省事，也不会出现同一句话两遍；
  // 给用户的反馈就是"字没丢，还在框里"。
  let pendingAutoSend = null;

  /** 会话就绪了：把"按了回车但还没发出去"的那条补发出去。 */
  function flushPendingSend() {
    if (pendingAutoSend === null) { return; }
    const tab = activeTab();
    if (!tab || !tab.piReady) { return; }
    const text = pendingAutoSend;
    pendingAutoSend = null;
    // 等待期间用户又改了输入框内容：那是他新的意思，不替他发
    if (inputEl.value.trim() !== text.trim()) { return; }
    send();
  }

  function send() {
    const tab = activeTab();
    const d = draftOfTab();
    const typed = inputEl.value.trim();
    const hasImages = (d.images || []).length > 0;
    const hasTextBlocks = (d.textBlocks || []).length > 0;
    if (!typed && !hasImages && !hasTextBlocks) { return; }
    let text = typed;
    if (hasTextBlocks) {
      const parts = d.textBlocks.map((b) => {
        const safeText = b.text.replace(/\u0060{4,}/g, (m) => m.split("").join("\u200b"));
        return "````\n" + safeText + "\n````";
      });
      text = (typed ? typed + "\n\n" : "") + parts.join("\n\n");
    }
    // 会话还没就绪（刚打开界面那一两秒）：记下这次回车，字留在输入框里，就绪后自动补发
    if (!tab || !tab.piReady) {
      pendingAutoSend = text;
      return;
    }
    pendingAutoSend = null;
    // 发送走 tab 级广播：后端把消息（含同一份附件）投给该 tab 内所有 panel
    vscode.postMessage({ type: "send", tabId: tab.id, text, images: d.images });
    resetComposer(d);
  }

  /** 发出去（真的发出去）以后把输入区恢复原样。 */
  function resetComposer(d) {
    inputEl.value = "";
    inputEl.style.height = INPUT_MIN_HEIGHT + "px";
    d.text = "";
    d.height = INPUT_MIN_HEIGHT;
    d.images = [];
    d.textBlocks = [];
    hideFileMenu(); hideHashMenu(); closeSlashMenu(); fileMenuEl.classList.add("hidden");
    renderAttachmentsFor();
  }

  // ==================== 事件绑定 ====================
  if (jumpBottomBtn) {
    jumpBottomBtn.addEventListener("click", () => {
      const tab = activeTab();
      if (tab) { scrollToBottom(tab, true); }
    });
  }
  // 每个 panel 底部都有自己的状态栏（.pane-status）：点击 = 切该 panel 模型

  // 委托：文件/符号链接点击（在 #messages 容器上）
  messagesEl.addEventListener("click", (e) => {
    const a = e.target.closest("a.file-link");
    if (a) { e.preventDefault(); const path = a.getAttribute("data-file"); if (!path) { return; } const line = a.dataset.line ? parseInt(a.dataset.line, 10) : undefined; const col = a.dataset.col ? parseInt(a.dataset.col, 10) : undefined; vscode.postMessage({ type: "openFile", path, line, col }); return; }
    const s = e.target.closest("a.symbol-link");
    if (s) { e.preventDefault(); const name = s.getAttribute("data-symbol"); if (name) { vscode.postMessage({ type: "openSymbol", name }); } return; }
  });
  messagesEl.addEventListener("dblclick", (e) => {
    const code = e.target && e.target.closest ? e.target.closest("code") : null;
    if (!code || code.closest("pre")) { return; }
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { return; }
      let tail = 0; const txt = sel.toString();
      while (tail < txt.length && /\s/.test(txt[txt.length - 1 - tail])) { tail++; }
      if (tail === 0) { return; }
      if (sel.focusNode && sel.focusNode.nodeType === Node.TEXT_NODE && sel.focusOffset >= tail) {
        sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset - tail);
      }
    }, 0);
  });

  // 用户主动接管滚动：滚轮上滑 / 触屏上滑 打断 lerp 追底（按实际滚动到的 pane 判定）
  messagesEl.addEventListener("wheel", (e) => {
    const pane = e.target.closest(".tab-pane");
    if (!pane) { return; }
    const t = tabs.get(pane.dataset.tabId);
    if (!t) { return; }
    if (e.deltaY < 0) { userTookOverScroll(t); }
  }, { passive: true });
  messagesEl.addEventListener("touchstart", (e) => {
    const pane = e.target.closest(".tab-pane");
    if (!pane) { return; }
    const t = tabs.get(pane.dataset.tabId);
    if (t) { userTookOverScroll(t); }
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (activeId === null) { return; }
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") { return; }
    const t = tabs.get(activeId);
    if (!t) { return; }
    const k = (e.key || "");
    if (k === "PageUp" || k === "ArrowUp" || k === "Home" || k === " ") { userTookOverScroll(t); }
  }, { passive: true });

  // 流式生成中中止：当前 tab 内所有生成中的 panel 一停全停
  function abortActiveTab() {
    if (activeStreamingLeaves().length === 0) { return false; }
    const focus = tabs.get(activeId);
    if (focus) { focus.pendingSteerRestore = (focus.queuedSteering || []).slice(); }
    vscode.postMessage({ type: "abort", tabId: activeId });
    return true;
  }

  // 网页端：点输入框里那颗“停止生成”图标 = 给当前 tab 按 Esc。
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (!abortActiveTab()) { syncStopBtn(); return; }
      // 先藏起来并禁用，等宿主的 streamEnd 回来再由 updateSendState 按真实状态刷新；
      // 万一点击没送到（连接断了），过一会儿按真实状态重新算：还在生成就把图标放回来。
      stopBtn.disabled = true;
      stopBtn.classList.add("hidden");
      setTimeout(syncStopBtn, 1500);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") { return; }
    if (pickerState && !pickerOverlay.classList.contains("hidden")) { return; }
    // 输入框聚焦时由 inputEl 的 keydown 处理（含文件菜单关闭 / 中止）
    if (document.activeElement === inputEl) { return; }
    // 消息流或其他区域聚焦 → 中止流式生成
    if (abortActiveTab()) { e.preventDefault(); }
  });

  inputEl.addEventListener("keydown", (e) => {
    if (!fileMenuEl.classList.contains("hidden")) {
      if (slashOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); moveSlashSel(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveSlashSel(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseSlash(); return; }
        if (e.key === "Escape") { e.preventDefault(); closeSlashMenu(); fileMenuEl.classList.add("hidden"); return; }
      }
      if (hashOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); moveHashSel(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveHashSel(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseHash(); return; }
        if (e.key === "Escape") { e.preventDefault(); hideHashMenu(); return; }
      }
      if (e.key === "ArrowDown") { e.preventDefault(); moveFileSel(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveFileSel(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseFile(); return; }
      if (e.key === "Escape") { e.preventDefault(); hideFileMenu(); return; }
    }
    // 复刻 pi TUI：流式生成中按 ESC 中止（文件菜单关闭时生效）
    if (e.key === "Escape") { if (abortActiveTab()) { e.preventDefault(); } return; }
    if (isSendKey(e)) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", () => { autoResize(); maybeShowFileMenu(); maybeShowHashMenu(); maybeShowSlashMenu(); });
  inputEl.addEventListener("blur", () => { setTimeout(() => { hideFileMenu(); hideHashMenu(); closeSlashMenu(); fileMenuEl.classList.add("hidden"); }, 150); });
  inputEl.addEventListener("paste", (e) => {
    if (!activeTab()) { return; }
    const d = draftOfTab();
    const cd = e.clipboardData; const items = (cd && cd.items) || [];
    let folded = false;
    for (const item of items) {
      if (item.kind === "string" && item.type === "text/plain") {
        const text = cd.getData("text/plain");
        if (shouldFoldText(text)) { e.preventDefault(); folded = true; const lines = text.split("\n").length; d.textBlocks.push({ text, lines, chars: text.length }); }
        break;
      }
    }
    let handledImage = false;
    for (const item of items) {
      if (item.type && item.type.indexOf("image/") === 0) {
        const file = item.getAsFile(); if (!file) { continue; }
        e.preventDefault(); handledImage = true;
        const reader = new FileReader();
        reader.onload = () => { const result = String(reader.result || ""); const comma = result.indexOf(","); const data = comma >= 0 ? result.slice(comma + 1) : result; d.images.push({ data, mimeType: file.type || "image/png" }); renderAttachmentsFor(); };
        reader.readAsDataURL(file);
      }
    }
    if (folded || handledImage) { renderAttachmentsFor(); }
  });

  // 初始：等待扩展推送 tabList / tabActivated

  function setStreaming(tab, on) {
    tab.streaming = on;
    // tab chip 流式灯：聚合当前 tab 内所有 panel
    const tv = tabViews.get(activeTabId);
    if (tv && leavesOf(tv.root).includes(tab.id)) {
      tv.streaming = leavesOf(tv.root).some((pid) => {
        const t = tabs.get(pid);
        return !!t && t.streaming;
      });
    }
    if (activeId === tab.id) { updateSendState(); syncStatus(); }
    // 非焦点 panel 也在当前 tab 里：停止按钮跟着整 tab 的状态变（焦点 panel 上面已带）
    else { syncStopBtn(); }
    renderTabBar(); updatePaneHeads();
  }
  function setActivity(tab, activity, detail) {
    tab.activity = activity || (tab.streaming ? "working" : "idle");
    tab.activityDetail = detail || "";
    if (activeId === tab.id) { syncStatus(); }
    renderTabBar();
    updatePaneHeads();
  }
  function setPiReady(tab, on, force) {
    tab.piReady = on;
    if (activeId === tab.id) { updateSendState(); syncStatus(); }
    renderTabBar();
    updatePaneHeads();
    // 会话就绪：把"按了回车但没发出去"的那条补发出去（见 flushPendingSend）
    if (on) { flushPendingSend(); }
  }

  // ==================== 来自扩展的消息 ====================
  window.addEventListener("message", (event) => {
    const msg = event.data;
    // VSCode webview 宿主会投递非业务消息（视图聚焦/状态同步等），event.data 可能为 null
    // 或非 {type:string} 结构。直接忽略，避免 msg.type 崩溃导致后续消息被跳过。
    if (!msg || typeof msg.type !== "string") { return; }
    const type = msg.type;

    if (type === "fetchChatResult") { applyFetchChatResult(msg); return; }
    if (type === "chatReferences") {
      chatReferences = Array.isArray(msg.items) ? msg.items : [];
      if (hashOpen) { maybeShowHashMenu(); }
      return;
    }

    if (type === "tabList") {
      enterMultiTab();
      const incoming = msg.tabs || [];
      const seenTabs = new Set();
      const seenPanels = new Set();
      incoming.forEach((t) => {
        seenTabs.add(t.id);
        let tv = tabViews.get(t.id);
        if (!tv) {
          tv = { id: t.id, name: t.name || "tab", root: t.root, focusPanelId: t.focusPanelId || null };
          tabViews.set(t.id, tv);
        } else {
          tv.name = t.name || tv.name;
          tv.root = t.root || tv.root;
          tv.focusPanelId = t.focusPanelId || tv.focusPanelId;
        }
        tv.streaming = !!t.streaming;
        tv.loading = !!t.loading;
        // 派子会话：这个 tab 是子会话，或者它派过子会话（前端据此画标记与右键菜单）
        tv.taba = t.taba || null;
        // panel 状态同步（递归布局树）
        const syncNode = (node) => {
          if (!node) { return; }
          if (node.kind === "panel") {
            seenPanels.add(node.panelId);
            let st = tabs.get(node.panelId);
            if (!st) {
              st = createTab(node.panelId, node.name || "新会话");
            } else if (node.name) {
              st.title = node.name;
            }
            st.streaming = !!node.streaming;
            const incomingActivity = node.activity;
            st.activity = incomingActivity === "working" || incomingActivity === "thinking" || incomingActivity === "tool" || incomingActivity === "idle"
              ? incomingActivity
              : (st.streaming ? "working" : "idle");
            st.activityDetail = typeof node.activityDetail === "string" ? node.activityDetail : "";
            st.piReady = node.piReady !== false;
            st.loading = !!node.loading;
            syncSessionLoading(st);
            // webview 重建（视图隐藏重开/窗口重载）后 tabList 是唯一信源：
            // modelChanged 是一次性推送，不在此恢复会导致状态栏模型名丢失。
            // 字段缺失（后端尚未拿到）时保留本地已有值。
            if (typeof node.modelId === "string") { st.modelId = node.modelId; }
            if (typeof node.provider === "string") { st.provider = node.provider; }
            if (typeof node.thinkingLevel === "string") { st.thinkingLevel = node.thinkingLevel; }
            if (typeof node.percent === "number") { st.percent = node.percent; }
            st.taba = node.taba || null;
          } else if (node.kind === "split") {
            (node.children || []).forEach(syncNode);
          }
        };
        syncNode(t.root);
      });
      // 移除已不存在的 tab / panel
      Array.from(tabViews.keys()).forEach((id) => {
        if (!seenTabs.has(id)) {
          tabViews.delete(id);
          tabDrafts.delete(id);
          maximized.delete(id);
        }
      });
      Array.from(tabs.keys()).forEach((id) => {
        if (!seenPanels.has(id)) { removeTab(id); }
      });
      // 活跃 tab 切换 / 焦点同步
      const wantActive = msg.activeId;
      if (wantActive && tabViews.has(wantActive)) {
        if (activeTabId !== wantActive) {
          if (activeTabId !== null) { saveInputState(); } else { carryComposerToTab(wantActive); }
          activeTabId = wantActive;
          const tv = tabViews.get(wantActive);
          activeId = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
            ? tv.focusPanelId
            : (leavesOf(tv.root)[0] || null);
          renderLayout();
          restoreInputState();
          reflectTabUI();
        } else {
          const tv = tabViews.get(wantActive);
          const wantFocus = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
            ? tv.focusPanelId
            : (leavesOf(tv.root)[0] || null);
          if (wantFocus && wantFocus !== activeId) {
            activeId = wantFocus;
            applyFocusClasses();
            reflectTabUI();
            renderAttachmentsFor();
          }
          const sig = layoutSignature();
          if (sig !== layoutSig) { renderLayout(); }
        }
      }
      renderTabBar();
      updateSendState(); syncStatus(); updatePaneHeads();
      // 刚连上的这一批 tab 里可能已经有就绪的：把排队中的消息发出去
      flushPendingSend();
      return;
    }
    if (type === "tabActivated") {
      enterMultiTab();
      const id = msg.id;
      if (id && tabViews.has(id)) {
        activateTabView(id);
      }
      return;
    }
    if (type === "tabClosed") {
      enterMultiTab();
      const wasActive = activeTabId === msg.id;
      tabViews.delete(msg.id);
      tabDrafts.delete(msg.id);
      maximized.delete(msg.id);
      // panel 由后续 tabList diff 清理；先切换视图避免空白
      if (wasActive) {
        activeTabId = tabViews.keys().next().value || null;
        if (activeTabId) {
          const tv = tabViews.get(activeTabId);
          activeId = (tv.focusPanelId && leavesOf(tv.root).includes(tv.focusPanelId))
            ? tv.focusPanelId
            : (leavesOf(tv.root)[0] || null);
          renderLayout();
          restoreInputState();
          reflectTabUI();
        } else {
          activeId = null;
        }
      }
      renderTabBar();
      return;
    }
    if (type === "viewOptions") { applyViewOptions(msg); return; }
    if (type === "picker") { renderPicker(msg); return; }
    // 插件那头把浮层收了（超时、被新的浮层顶掉、页面被换下）：这边跟着收起来，别留一个点不动的空壳。
    if (type === "pickerCancel") { hidePicker(); return; }
    if (type === "historyPageAppend") {
      const st = pickerState;
      if (st && st.kind === "history") {
        const more = Array.isArray(msg.items) ? msg.items : [];
        st.items = st.items.concat(more);
        st.historyHasMore = msg.hasMore === true;
        st.historyLoading = false;
        renderPickerItems();
      }
      return;
    }
    if (type === "historyPageEnd") {
      const st = pickerState;
      if (st && st.kind === "history") {
        st.historyLoading = false;
        renderPickerItems();
      }
      return;
    }
    if (type === "openSettings") { openSettings(msg.tab); return; }
    if (type === "viewOptionItems") { viewOptionItems = Array.isArray(msg.items) ? msg.items : []; if (settingsActiveTab === "options") { renderViewOpts(); } return; }
    if (type === "focusInput") { setTimeout(function () { inputEl.focus(); }, 0); return; }
    // 扩展宿主在某个 session 收尾时下发的提示音请求（所有 session 都会收到，不再只看焦点）。
    if (type === "beep") { if (notifyOnTurnEnd) { playTurnEndBeep(); } return; }
    if (type === "app:settings" || type === "app:settingsResult" || type === "app:defaultModels") {
      if (settingsDispatch) {
        if (type === "app:settings") { settingsDispatch({ type: "load", content: msg.content, existed: msg.existed, path: msg.path }); }
        else if (type === "app:settingsResult") { settingsDispatch(msg.ok ? { type: "saved" } : { type: "error", error: msg.error }); }
        else { settingsDispatch({ type: "default", content: msg.content }); }
      }
      return;
    }
    if (type === "app:probeModelsResult") {
      if (settingsDispatch) {
        settingsDispatch({ type: "probeResult", ok: !!msg.ok, models: msg.models || [], error: msg.error });
      }
      return;
    }
    if (type === "openFiles") {
      openFiles = msg.files || [];
      if (atStart >= 0) {
        const pos = inputEl.selectionStart; const before = inputEl.value.slice(0, pos);
        const m = before.match(/(^|\s)@([^\s@]*)$/);
        filterFiles(m ? m[2] : "");
      }
      return;
    }

    if (type === "commandList") {
      commandListCache = Array.isArray(msg.items) ? msg.items : [];
      if (commandListCache.length > 0) { commandListReqAt = 0; }
      if (slashOpen) {
        const m = inputEl.value.match(/^\/(\S*)$/);
        if (m) { filterSlashMenu(m[1]); } else { closeSlashMenu(); }
      }
      return;
    }

    if (type === "symbolSet") {
      symbolNames = new Set(msg.names || []);
      // 符号集合变化后，已渲染消息里的反引号可能需变成可点击链接：重渲染各 tab 的 .md；
      // 流式中的活跃消息交给 flush 管线，避免与流式渲染竞争。
      for (const st of tabs.values()) {
        if (st.currentAssistant) { st.textDirty = true; scheduleFlush(st); }
        st.paneEl.querySelectorAll(".md").forEach((el) => {
          if (st.currentAssistant && el === st.currentAssistant.el) { return; }
          const raw = el.dataset.raw;
          if (typeof raw === "string") { el.innerHTML = renderMarkdown(raw); }
        });
      }
      return;
    }

    // tab 级消息
    applyPanelMessage(msg);
  });

  /**
   * panel 级消息（带 tabId）：用户消息、流式增量、工具卡片、历史窗口等，逐条应用到对应窗格。
   * 抽成独立函数：网页端「加载更早」那批历史消息会包在 historyBatchEvent 里逐条送来，
   * 渲染进暂存区时也要走同一套分发（见 historyBatchEvent 那个 case）。
   */
  function applyPanelMessage(msg) {
    const type = msg.type;
    const tabId = msg.tabId;
    let t = null;
    if (tabId) {
      enterMultiTab();
      t = tabs.get(tabId) || createTab(tabId, "新会话");
    } else {
      // 兜底：无 tabId 的消息（后端尚未推送 tabList）时惰性创建默认 tab
      t = ensureDefaultTab();
    }
    if (!t) { return; }
    // 安全网：多 tab 模式下若尚无活跃 tab（tabList 未到的竞态），激活当前面板。
    // 注意别在这里碰输入框：这时 activeTabId 还是空的（tabList 没到，草稿还没有主），
    // restoreInputState 会拿空草稿把用户刚打的字冲掉。搬运与恢复交给 tabList 那段做。
    if (multiTab && !activeId) {
      activeId = t.id;
      reflectTabUI();
    }

    switch (type) {
      case "userMessage": {
        finalizeCurrentAssistant(t);
        const label = msg.imageCount ? "[" + msg.imageCount + " 张图片] " : "";
        addPlain(t, "user", "你", label + (msg.text || ""));
        t.thinkingText = "";
        scrollToBottom(t, true);
        break;
      }
      case "streamStart":
        t.activity = msg.activity || "working";
        t.activityDetail = msg.detail || "";
        setStreaming(t, true);
        finalizeCurrentAssistant(t);
        t.thinkingText = "";
        // 新一轮生成：速度计时重新开始，上一轮均值先清零（有数据后由实时值接管）
        t.tps = undefined;
        t.tpsStart = Date.now();
        t.tpsTokens = 0;
        break;
      case "streamEnd":
        if (t.rafId) { flushDeltas(t); }
        finalizeCurrentAssistant(t);
        t.thinkingText = "";
        // 结算本轮速度均值（必须在 setStreaming(false) 前算，之后 currentTps 改用 t.tps）
        {
          const secs = t.tpsStart > 0 ? (Date.now() - t.tpsStart) / 1000 : 0;
          if (t.tpsTokens > 0 && secs > 0.3) { t.tps = t.tpsTokens / secs; }
          t.tpsStart = 0;
          t.tpsTokens = 0;
        }
        t.activity = msg.activity || "idle";
        t.activityDetail = msg.detail || "";
        setStreaming(t, false);
        // 提示音改由扩展宿主在“一轮真正结束”时下发 beep 消息（见 notifyOnTurnEnd），
        // 这里不再对焦点 session 单独出声：多 tab / 分屏时后台 session 跑完也能听见。
        break;
      case "activityChanged":
        setActivity(t, msg.activity, msg.detail);
        break;
      case "assistantDelta":
        if (!t.currentAssistant) { t.currentAssistant = { el: addMarkdown(t, ""), raw: "" }; }
        t.currentAssistant.raw += msg.delta;
        t.textDirty = true;
        scheduleFlush(t);
        t.tpsTokens += estTokens(msg.delta);
        noteTpsProgress(t);
        break;
      case "assistantFull":
        finalizeCurrentAssistant(t);
        addMarkdown(t, msg.text);
        t.currentAssistant = null;
        break;
      case "thinkingDelta":
        // 兼容较旧后端：即使没有先收到 activityChanged，也按 thinking 渲染。
        if (t.activity !== "thinking") { t.activity = "thinking"; }
        t.thinkingText += msg.delta;
        t.tpsTokens += estTokens(msg.delta);
        if (activeId === t.id) { syncStatus(); }
        break;
      case "tool": {
        finalizeCurrentAssistant(t);
        const argStr = msg.args ? JSON.stringify(msg.args) : "";
        addTool(t, msg.toolName, argStr, msg.toolCallId);
        t.currentAssistant = null;
        break;
      }
      case "editCardStart": {
        finalizeCurrentAssistant(t);
        const card = buildEditCard(t, msg.toolName, msg.label, msg.path, msg.toolCallId, msg.args ? JSON.stringify(msg.args) : "");
        t.pendingToolCards.set(msg.toolCallId, card);
        t.currentAssistant = null;
        break;
      }
      case "editCardResult": {
        const card = t.pendingToolCards.get(msg.toolCallId);
        if (card) {
          card.setResult(msg);
          scrollToBottom(t);
          if (!msg.canRevert) { t.pendingToolCards.delete(msg.toolCallId); }
        }
        break;
      }
      case "editReverted": {
        const card = t.pendingToolCards.get(msg.toolCallId);
        if (card && card.markReverted) { card.markReverted(); }
        t.pendingToolCards.delete(msg.toolCallId);
        break;
      }
      case "system":
        addPlain(t, "system", null, msg.text);
        break;
      case "systemError":
        addPlain(t, "system error", null, msg.text);
        break;
      case "clear":
        cancelFlush(t);
        hideTagTip();
        t.paneEl.innerHTML = '<div class="empty-hint">输入消息开始对话…</div>';
        // 历史窗口状态一并重置：按钮随 innerHTML 清掉了；暂存区里若有没插完的
        // 「加载更早」那批也作废（会话已换，再插进去就串了），置个丢弃标记等 End 来清
        t._historyBtn = null;
        t.hasMoreHistory = false;
        if (t._stage) { t._stage = null; t._stageDropped = true; }
        ensurePaneHead(t);
        // 后端可能在 loading 状态中再次 clear（例如切换完成后重绘消息），
        // 不能因此把进行中的加载反馈一并清掉。
        syncSessionLoading(t);
        t.currentAssistant = null;
        t.thinkingText = "";
        t.currentToolRow = null;
        t.lastTagHost = null;
        t.lastAssistantEl = null;
        t.pendingToolCards.clear();
        for (const tg of t.pendingToolTags.values()) { clearInterval(tg._timer); }
        t.pendingToolTags.clear();
        // 重置当前 tab 的输入草稿（若该 panel 在当前 tab，同步到输入框）。
        // 整屏重画（页面刷新 / 重连后补内容）也走 clear：那种 clear 带 keepDraft，
        // 不能把人打了一半的字和附件抹掉，也不要把键盘拉起来。
        if (!msg.keepDraft && activeId === t.id) {
          const d = draftOfTab();
          d.text = "";
          d.height = INPUT_MIN_HEIGHT;
          d.images = [];
          d.textBlocks = [];
          inputEl.value = "";
          inputEl.style.height = INPUT_MIN_HEIGHT + "px";
          renderAttachmentsFor();
          inputEl.focus();
        }
        break;
      case "toolResultUpdate": {
        // 缓存部分结果，悬浮提示随取随画
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl._resultText = msg.resultText || "";
          tagEl._resultMeta = { isPartial: true, durationMs: msg.durationMs };
          setTagTip(tagEl, tagEl._resultText, "");
        }
        break;
      }
      case "toolResult": {
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl.classList.remove("running");
          if (msg.isError) { tagEl.classList.add("error"); }
          // 记录结果：文字结果供悬浮提示用（见 setTagTip），带图的走另一条路
          tagEl._done = true;
          tagEl._isError = !!msg.isError;
          tagEl._resultText = msg.resultText || "";
          tagEl._resultMeta = { isError: !!msg.isError, durationMs: msg.durationMs, truncation: msg.truncation || null, images: msg.images || null };
          // read 读图：小标签直接换成对话里的一整块图（不再走悬浮提示）
          if (Array.isArray(msg.images) && msg.images.length > 0) {
            mountToolImageBlock(t, tagEl, msg.images);
          } else {
            setTagTip(tagEl, tagEl._resultText, "");
          }
          t.pendingToolTags.delete(msg.toolCallId);
        }
        break;
      }
      case "modelChanged":
        t.modelId = msg.modelId || "";
        t.provider = msg.provider || "";
        if (activeId === t.id) { syncStatus(); }
        updatePaneHeads();
        break;
      case "thinkingChanged":
        t.thinkingLevel = msg.level || "";
        if (activeId === t.id) { syncStatus(); }
        break;
      case "stats": {
        // 上下文用量：供 panel 状态栏的百分比显示与颜色预警
        const cu = msg.contextUsage;
        if (cu) {
          if (typeof cu.percent === "number") { t.percent = cu.percent; }
          if (typeof cu.tokens === "number") { t.tokens = cu.tokens; }
          if (typeof cu.contextWindow === "number") { t.contextWindow = cu.contextWindow; }
        }
        if (activeId === t.id) { syncStatus(); }
        updatePaneHeads();
        break;
      }
      case "queueUpdate":
        t.queuedSteering = Array.isArray(msg.steering) ? msg.steering : [];
        // abort 后队列被清空：把未投递的 steer 文本合并写回输入框（与 TUI 一致）
        if (t.pendingSteerRestore && t.pendingSteerRestore.length && t.queuedSteering.length === 0) {
          const texts = t.pendingSteerRestore.filter((s) => typeof s === "string" && s);
          t.pendingSteerRestore = null;
          if (texts.length && activeId === t.id) {
            const joined = texts.join("\n\n");
            inputEl.value = inputEl.value ? (inputEl.value.replace(/\s+$/, "") + "\n\n" + joined) : joined;
            autoResize();
            inputEl.focus();
          }
        }
        if (activeId === t.id) { renderQueueBar(t); }
        break;
      case "piReady":
        setPiReady(t, msg.ready === true);
        break;
      case "historyWindow":
        // 网页端「只发最近一段历史」：hasMore 为真时在顶部画「加载更早的消息」按钮
        setHistoryWindow(t, msg.hasMore === true, typeof msg.hidden === "number" ? msg.hidden : 0);
        break;
      case "historyBatchEvent": {
        // 「加载更早」那批消息：逐条包在 event 里送来。先渲染进暂存区（不在页面上），
        // historyBatchEnd 到了再整体插到顶部——中间若穿插流式消息，它们照常走真实窗格，不会串序。
        if (t._stageDropped) { break; }
        const inner = msg.event && typeof msg.event === "object" ? msg.event : null;
        if (!inner) { break; }
        if (!t._stage) { t._stage = document.createElement("div"); }
        inner.tabId = msg.tabId;
        const realPane = t.paneEl;
        const savedStick = t.stickToBottom;
        const savedProgrammatic = t.programmaticScroll;
        t.paneEl = t._stage;
        try { applyPanelMessage(inner); }
        finally {
          t.paneEl = realPane;
          // 渲染进暂存区时的滚动状态调整（scrollToBottom 等）不该影响真实窗格
          t.stickToBottom = savedStick;
          t.programmaticScroll = savedProgrammatic;
        }
        break;
      }
      case "historyBatchEnd":
        flushHistoryBatch(t, msg.hasMore === true, typeof msg.hidden === "number" ? msg.hidden : 0);
        break;
    }
  }

  // ==================== 历史窗口（网页端「只发最近一段历史」） ====================

  /**
   * 顶部「加载更早的消息」按钮。
   * hasMore 为假时移除按钮；hidden 是还没显示的更早消息条数，拼进按钮文字。
   * 按钮插在窗格最顶上，往后渲染的消息都排在它后面。
   */
  function setHistoryWindow(t, hasMore, hidden) {
    t.hasMoreHistory = hasMore;
    const pane = t.paneEl;
    let btn = t._historyBtn;
    if (!hasMore) {
      if (btn) { btn.remove(); t._historyBtn = null; }
      return;
    }
    if (!btn || btn.parentNode !== pane) {
      if (btn) { btn.remove(); }
      btn = document.createElement("button");
      btn.className = "history-more";
      btn.type = "button";
      btn.addEventListener("click", () => {
        if (btn.disabled || t._stage) { return; }
        btn.disabled = true;
        btn.textContent = "加载中…";
        vscode.postMessage({ type: "loadOlderHistory", tabId: t.id });
      });
      t._historyBtn = btn;
      // 面板头（拖动条）永远留在最顶上，按钮排在它后面
      const head = pane.querySelector(":scope > .pane-head");
      if (head) { pane.insertBefore(btn, head.nextSibling); }
      else { pane.insertBefore(btn, pane.firstChild); }
    }
    btn.disabled = false;
    btn.textContent = "加载更早的消息" + (hidden > 0 ? "（还有 " + hidden + " 条）" : "");
  }

  /**
   * 「加载更早」那批消息渲染完了：把暂存区的内容整体插到按钮下方，
   * 并把滚动位置同步下移，让视野还停在原来那几条消息上。
   * 会话在加载途中被切换过（clear 已把暂存区作废）就不插了。
   */
  function flushHistoryBatch(t, hasMore, hidden) {
    const stage = t._stage;
    t._stage = null;
    const dropped = t._stageDropped === true;
    t._stageDropped = false;
    if (dropped) {
      // 会话已换：那批作废，按钮也一并收掉（新会话自己的 historyWindow 会重新决定要不要按钮）
      setHistoryWindow(t, false, 0);
      return;
    }
    setHistoryWindow(t, hasMore, hidden);
    if (!stage || !stage.childNodes.length) { return; }
    const pane = t.paneEl;
    const btn = t._historyBtn;
    let anchor;
    if (btn && btn.parentNode === pane) {
      anchor = btn.nextSibling;
    } else {
      // 没按钮就插在面板头后面（面板头永远留在最顶上）
      const head = pane.querySelector(":scope > .pane-head");
      anchor = head ? head.nextSibling : pane.firstChild;
    }
    const beforeHeight = pane.scrollHeight;
    while (stage.firstChild) { pane.insertBefore(stage.firstChild, anchor); }
    if (pane.isConnected) {
      // 上方变高了：滚动位置同步下移，让视野还停在原来那几条消息上
      pane.scrollTop += pane.scrollHeight - beforeHeight;
    }
  }

  function removeTab(id) {
    const st = tabs.get(id);
    if (!st) { return; }
    cancelFlush(st);
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); }
    for (const tg of st.pendingToolTags.values()) { clearInterval(tg._timer); }
    st.paneEl.remove();
    tabs.delete(id);
    if (activeId === id) { activeId = null; syncJumpBottom(st); syncStopBtn(); }
  }

  // ==================== 设置（models.json）浮层 ====================
  const settingsOverlay = document.getElementById("settingsOverlay");
  const settingsRoot = document.getElementById("settingsRoot");
  let settingsInstance = null;
  let settingsDispatch = null;
  let settingsActiveTab = "models";
  let viewOptionItems = [];
  const viewOptsRoot = document.getElementById("viewOptsRoot");

  function ensureSettingsMounted() {
    if (settingsInstance) { return; }
    settingsInstance = window.mountSettings(settingsRoot, {
      send(type, payload) {
        if (type === "save") { vscode.postMessage({ type: "app:saveSettings", content: (payload && payload.content) || "" }); }
        else if (type === "probeModels") {
          vscode.postMessage({
            type: "app:probeModels",
            baseUrl: (payload && payload.baseUrl) || "",
            apiKey: (payload && payload.apiKey) || "",
            api: (payload && payload.api) || "",
          });
        }
        else { vscode.postMessage({ type: "app:requestSettings" }); } // ready
      },
      on(handler) { settingsDispatch = handler; },
      onClose() { closeSettings(); },
    });
  }

  function applySettingsTab() {
    document.querySelectorAll(".settings-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === settingsActiveTab);
    });
    settingsRoot.classList.toggle("hidden", settingsActiveTab !== "models");
    viewOptsRoot.classList.toggle("hidden", settingsActiveTab !== "options");
  }

  function renderViewOpts() {
    viewOptsRoot.innerHTML = "";
    if (!viewOptionItems.length) {
      const empty = document.createElement("div"); empty.className = "vo-empty"; empty.textContent = "没有可配置项";
      viewOptsRoot.appendChild(empty); return;
    }
    viewOptionItems.forEach((it) => {
      const row = document.createElement("div"); row.className = "vo-item";
      if (it.kind === "slider") { renderSliderRow(row, it); viewOptsRoot.appendChild(row); return; }
      if (Array.isArray(it.options) && it.options.length) {
        // 按钮组：直接点选某个选项
        row.classList.add("vo-item-group");
        const txt = document.createElement("div"); txt.className = "vo-text";
        const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
        txt.appendChild(label);
        if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
        row.appendChild(txt);
        const group = document.createElement("div"); group.className = "vo-group";
        it.options.forEach((opt) => {
          const b = document.createElement("button"); b.type = "button";
          b.className = "vo-group-btn" + (opt.value === it.value ? " on" : "");
          b.textContent = opt.label;
          b.addEventListener("click", () => {
            vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: opt.value });
          });
          group.appendChild(b);
        });
        row.appendChild(group);
      } else {
        const check = document.createElement("span"); check.className = "vo-check" + (it.check === true ? " on" : "");
        check.innerHTML = it.check === true ? ICONS.check : "";
        const txt = document.createElement("div"); txt.className = "vo-text";
        const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
        txt.appendChild(label);
        if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
        row.appendChild(check); row.appendChild(txt);
        row.addEventListener("click", () => {
          vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: it.value });
        });
      }
      viewOptsRoot.appendChild(row);
    });
  }
  function renderSliderRow(row, it) {
    row.classList.add("vo-item-slider");
    const txt = document.createElement("div"); txt.className = "vo-text";
    const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
    txt.appendChild(label);
    if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
    row.appendChild(txt);
    const ctrl = document.createElement("div"); ctrl.className = "vo-slider";
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(it.min ?? 0); range.max = String(it.max ?? 100); range.step = String(it.step ?? 1);
    // 当前值：有存值用存值；否则读 body 实际字号，让滑块初始位置反映现状
    const cur = it.value && /^\d+$/.test(String(it.value))
      ? Number(it.value)
      : Math.round(parseFloat(getComputedStyle(document.body).fontSize) || 13);
    range.value = String(cur);
    const out = document.createElement("span"); out.className = "vo-slider-val"; out.textContent = cur + (it.unit || "");
    range.addEventListener("input", () => { out.textContent = range.value + (it.unit || ""); });
    range.addEventListener("change", () => {
      vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: range.value });
    });
    ctrl.appendChild(range); ctrl.appendChild(out);
    row.appendChild(ctrl);
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "vo-slider-reset";
    reset.textContent = "跟随 VSCode";
    reset.addEventListener("click", () => {
      vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: "" });
    });
    row.appendChild(reset);
  }

  function openSettings(tab) {
    const wasVisible = !settingsOverlay.classList.contains("hidden");
    settingsActiveTab = tab === "options" ? "options" : "models";
    ensureSettingsMounted();
    applySettingsTab();
    if (!wasVisible && settingsActiveTab === "models") { settingsInstance.requestInitial(); }
    if (settingsActiveTab === "options") {
      vscode.postMessage({ type: "requestViewOptionItems" });
      renderViewOpts();
    }
    settingsOverlay.classList.remove("hidden");
  }
  function closeSettings() {
    settingsOverlay.classList.add("hidden");
  }
  settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) { closeSettings(); } });
  document.querySelectorAll(".settings-tab").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.tab;
      if (!t || t === settingsActiveTab) { return; }
      settingsActiveTab = t;
      if (t === "models") { ensureSettingsMounted(); }
      applySettingsTab();
      if (t === "options") { vscode.postMessage({ type: "requestViewOptionItems" }); renderViewOpts(); }
    });
  });
  const settingsCloseBtn = document.getElementById("settingsClose");
  if (settingsCloseBtn) { settingsCloseBtn.addEventListener("click", closeSettings); }

  vscode.postMessage({ type: "ready" });
})();
