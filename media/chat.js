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
  const messagesEl = document.getElementById("messages"); // 容器，内含各 .session-pane
  const jumpBottomBtn = document.getElementById("jumpBottom");
  const stopBtn = document.getElementById("stopBtn"); // 停止生成图标：browserBridge.js 在两种页面里都会创建
  const continueBtn = document.getElementById("continueBtn"); // “继续”快捷按钮：同上，与停止图标共用一个位置
  // VSCode 官方 codicon 的 chevron-right 折线图标（从 @vscode/codicons 包取出）。
  // 各处折叠小三角用同一份：画的是朝右，展开时靠 CSS transform 转成朝下。
  const CHEVRON_SVG =
    '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">' +
    '<path d="M6.14601 3.14579C5.95101 3.34079 5.95101 3.65779 6.14601 3.85279L10.292 7.99879L6.14601 12.1448C5.95101 12.3398 5.95101 12.6568 6.14601 12.8518C6.34101 13.0468 6.65801 13.0468 6.85301 12.8518L11.353 8.35179C11.548 8.15679 11.548 7.83979 11.353 7.64478L6.85301 3.14479C6.65801 2.94979 6.34101 2.95079 6.14601 3.14579Z"/></svg>';
  // 其余小图标：同样取自 @vscode/codicons 包，fill=currentColor 跟随文字色（files 是 24 视图）。
  const ICONS = {
    close: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8.70701 8.00001L12.353 4.35401C12.548 4.15901 12.548 3.84201 12.353 3.64701C12.158 3.45201 11.841 3.45201 11.646 3.64701L8.00001 7.29301L4.35401 3.64701C4.15901 3.45201 3.84201 3.45201 3.64701 3.64701C3.45201 3.84201 3.45201 4.15901 3.64701 4.35401L7.29301 8.00001L3.64701 11.646C3.45201 11.841 3.45201 12.158 3.64701 12.353C3.74501 12.451 3.87301 12.499 4.00101 12.499C4.12901 12.499 4.25701 12.45 4.35501 12.353L8.00101 8.70701L11.647 12.353C11.745 12.451 11.873 12.499 12.001 12.499C12.129 12.499 12.257 12.45 12.355 12.353C12.55 12.158 12.55 11.841 12.355 11.646L8.70901 8.00001H8.70701Z"/></svg>',
    // 粗一点的关闭叉：会话行尾、面板头部「关掉这一屏」的地方共用这一颗，大小一致。
    "close-bold": '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.5 2.5 L13.5 13.5 M13.5 2.5 L2.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
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
    // 下面两个给“项目与会话”抽屉面板用：文件夹（工作区/浏览行）、两根滑杆（底部“设置”，
    // 比 ⚙ 字符在各主题下都稳定）。
    folder: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M1.5 1A1.5 1.5 0 0 0 0 2.5v10.997A1.5 1.5 0 0 0 1.5 15h12.987a1.5 1.5 0 0 0 1.5-1.5V4.5a1.5 1.5 0 0 0-1.5-1.5H8.707L7.361 1.654A1.5 1.5 0 0 0 6.207 1H1.5Z"/></svg>',
    // 加号：面板里「在新工作区新建会话」那一行用（跟顶条那颗新建会话同一颗图标）。
    add: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8 1.5C8 1.22386 7.77614 1 7.5 1C7.22386 1 7 1.22386 7 1.5V7H1.5C1.22386 7 1 7.22386 1 7.5C1 7.77614 1.22386 8 1.5 8H7V13.5C7 13.7761 7.22386 14 7.5 14C7.77614 14 8 13.7761 8 13.5V8H13.5C13.7761 8 14 7.77614 14 7.5C14 7.22386 13.7761 7 13.5 7H8V1.5Z"/></svg>',
    sliders: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 4.5h6.2M11.8 4.5H14M2 11.5h1.7M7.3 11.5H14"/><circle cx="10" cy="4.5" r="1.8"/><circle cx="5.5" cy="11.5" r="1.8"/></svg>',
    // 子会话的拐角箭头（“↳”）：先从上面下来、再向右拐，像个挂在父会话下面的分叉。
    // 用 SVG 而不是文字符号：箭头在 Segoe UI 等字体里居中不对，画出来天然齐。
    child: '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 1.6V8.4H12.6"/><path d="M9.8 5.6L12.8 8.4L9.8 11.2"/></svg>',
  };
  /** 文件夹选择器里行首那颗图标：名字由宿主给（见 chatHostBase.showFolderPicker 的 items）。 */
  const FOLDER_ROW_ICONS = { check: ICONS.check, up: ICONS["arrow-up"], folder: ICONS.folder };
  /** 抽屉列表里“磁盘上存着的会话”那一段的标题：历史抽屉与「项目与会话」上半共用。 */
  const HISTORY_SECTION = "历史会话";
  const inputEl = document.getElementById("input");
  const imgPreviewEl = document.getElementById("imgPreview");
  const fileMenuEl = document.getElementById("fileMenu");
  const queueBarEl = document.getElementById("queueBar");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const sessionNameBtn = document.getElementById("sessionName");
  // 顶条名字底下那行小字：当前会话跑在哪个目录（内容由 renderSessionBar 填）
  const sessionPathEl = document.getElementById("sessionPath");
  const sessionPathTextEl = sessionPathEl ? sessionPathEl.querySelector(".sp-text") : null;
  // 顶条中间那一列（会话名 + 目录两行）：两行合起来就是一块可点区域，见下面的点击监听
  const sessionCenterEl = document.getElementById("sessionCenter");
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
  newSessionBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
  });
  // 顶条中间那一列（会话名 + 底下那行目录）：点哪一行都掉出同一张清单。
  // 挂在整列上而不是名字那颗按钮上：两行都得是可点区域；按钮上按回车出来的点击也会冒到这里。
  sessionCenterEl.addEventListener("click", () => { toggleSessionMenu(); });
  // 名字后面那颗朝下的小箭头：只在开着两个以上会话时露面（提示这里点得开、能换）。
  // 画的还是那份 chevron（画的是朝右），转 90° 成朝下。
  const sessionCaret = document.createElement("span");
  sessionCaret.className = "sn-caret hidden";
  sessionCaret.setAttribute("aria-hidden", "true");
  sessionCaret.innerHTML = CHEVRON_SVG;
  sessionNameBtn.appendChild(sessionCaret);

  // ---- 会话本地状态（后端 sessionList 消息驱动）----
  // sessions：一个会话一份状态（消息窗格 + 底部状态栏 + 名字 / 状态 / 父子关系）。
  // 一次只看一个会话：activeId 就是当前这个，其余会话的 DOM 留在内存里，切回去接着看。
  const sessions = new Map();        // sessionId -> state
  const sessionDrafts = new Map();   // sessionId -> { text, selStart, selEnd, height }（输入草稿按会话存）
  let sessionOrder = [];             // 后端给的会话顺序（列表段按它画）
  let activeId = null;               // 当前显示的会话 id
  // 后端说“你这块屏切到这个会话”但那个会话的壳还没建出来（列表在路上）：记下来等它到了一起用
  let pendingActivateId = null;
  // 会话列表里点过“关闭”的那一行：等第二次点击确认（几秒后自动撤销，防误触）。
  let pendingCloseId = null;
  let pendingCloseTimer = null;

  // ---- 通用拾取器浮层（模型 / 历史）----
  const pickerOverlay = document.getElementById("pickerOverlay");
  const pickerBody = document.getElementById("pickerBody");
  const pickerTitle = document.getElementById("pickerTitle");
  const pickerSubtitle = document.getElementById("pickerSubtitle");
  /**
   * 标题下面那行小字（目前只有文件夹选择器用：正在看的是哪个目录）。
   * 骨架里没这个元素时（插件与后端的版本对不上：界面文件是现从后端取的）就当没有，不能让浮层打不开。
   */
  function setPickerSubtitle(text) {
    if (!pickerSubtitle) { return; }
    pickerSubtitle.textContent = text || "";
    pickerSubtitle.classList.toggle("hidden", !text);
  }
  const pickerHeader = document.getElementById("pickerHeader");
  const pickerSearch = document.getElementById("pickerSearch");
  const pickerSearchWrap = document.getElementById("pickerSearchWrap");
  const pickerFooter = document.getElementById("pickerFooter");
  /** 「选一个」浮层底下那行自由填写（选项都不合适时自己写）。 */
  const pickerInput = document.getElementById("pickerInput");
  const pickerInputWrap = document.getElementById("pickerInputWrap");
  let pickerState = null; // { kind, items, filtered, sel, current, draftModel, draftThinking, toggle }

  // ==================== Markdown / 文件链接 / 符号链接（纯函数，与是哪个会话无关）====================
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
          const language = resolveHighlightLanguage(hljs, lang) || "plaintext";
          return highlightCached(hljs, language, code);
        } catch { return code; }
      }
    }));
  }
  /**
   * 语法高亮的结果缓存：同一块代码（语言一样、内容一字不差）不重复高亮。
   * 流式里前面的代码块会随着整段重画反复出现，缓存命中后大段的重新着色就没了；
   * 只有正在长的那一块每次都变，那时才会真的重算。
   */
  const HIGHLIGHT_CACHE = new Map();
  const HIGHLIGHT_CACHE_MAX = 200;
  function highlightCached(hljs, language, code) {
    const key = language + "\u0000" + code;
    const hit = HIGHLIGHT_CACHE.get(key);
    if (hit !== undefined) { return hit; }
    const value = hljs.highlight(code, { language }).value;
    if (HIGHLIGHT_CACHE.size >= HIGHLIGHT_CACHE_MAX) { HIGHLIGHT_CACHE.clear(); }
    HIGHLIGHT_CACHE.set(key, value);
    return value;
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
  // marked 的解析选项：整段渲染与按块渲染必须用同一套，否则两种路径出来的东西会不一样。
  // 每回给一份新的：marked 会往传进去的选项对象上写东西（加 tokenizer 字段），
  // 共享或冻结的对象会直接被它撞坏（症状是静默地报错回退）。
  function mdOptions() { return { breaks: true, gfm: true }; }
  function renderInline(text) { ensureMarkedHighlight(); ensureFileLink(); return marked.parseInline(text, { gfm: true }); }
  function renderMarkdown(source) { ensureMarkedHighlight(); ensureFileLink(); return marked.parse(source, mdOptions()); }

  /**
   * 按当前符号集合，把已渲染正文里的行内代码就地变成可点击的符号链接（或还原回普通文字）。
   *
   * 为什么整段重画（el.innerHTML = renderMarkdown(el.dataset.raw)）不行：工具标签、edit/write
   * 小标签是运行时挂进 .md 里的 DOM，重画只认 markdown 原文，会把这些节点一起抹掉——
   * 表现就是"工具调用时不时不见了"。只改行内 code 节点，别的东西一律不动。
   *
   * 判断规则与 marked 的 codespan 渲染器保持一致：文件路径优先（那类已经是文件链接，不动），
   * 再看整段文本、或去掉结尾 () 的裸名在不在符号集合里。
   */
  function applySymbolLinks(mdEl) {
    // 先还原：符号集合变小了（文件关掉、换会话），原来挂上去的链接就该不再可点
    mdEl.querySelectorAll("a.symbol-link").forEach((a) => {
      const name = a.getAttribute("data-symbol") || "";
      if (symbolNames.has(name)) { return; }
      const code = a.parentElement;
      a.replaceWith(document.createTextNode(a.textContent || ""));
      if (code) { code.normalize(); }
    });
    mdEl.querySelectorAll("code").forEach((code) => {
      if (code.parentElement && code.parentElement.tagName === "PRE") { return; } // 代码块里的不碰
      if (code.firstElementChild) { return; } // 已经有链接（文件或符号）
      const text = code.textContent || "";
      if (!text) { return; }
      const m = FILE_RE.exec(text);
      if (m && isFilePathlike(m[1])) { return; }
      let name = text;
      if (!symbolNames.has(name)) {
        const bare = text.replace(/\(\)$/, "");
        if (bare === text || !symbolNames.has(bare)) { return; }
        name = bare;
      }
      const a = document.createElement("a");
      a.className = "symbol-link";
      a.href = "#";
      a.setAttribute("data-symbol", name);
      a.textContent = text;
      code.textContent = "";
      code.appendChild(a);
    });
  }

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
    // 字号一变，同一行字占的高度也跟着变：输入框的高度得按新字号重算，
    // 否则框还是旧字号时量出来的那么高，右边就冒出一根滚动条（见 autoResize）。
    autoResize();
  }
  function applyViewOptions(opts) {
    if (typeof opts.fontSize === "string") { applyFontSize(opts.fontSize); }
    if (typeof opts.sendKey === "string") { sendKeyCombo = opts.sendKey; }
    if (typeof opts.newSessionKey === "string") { newSessionKey = opts.newSessionKey; }
    if (typeof opts.tabSwitchKey === "string") { tabSwitchKey = opts.tabSwitchKey; }
    notifyOnTurnEnd = opts.notifyOnTurnEnd !== false && opts.notifyBeep !== false;
  }

  // ── 会话结束提示音（Web Audio 合成，无外部资源） ──
  // 由扩展宿主发 "turnEnd" 消息触发，不再只看当前会话（别的会话跑完也响）。
  // 页面被隐藏时（窗口切到后台、插件里的对话面板被切走、页面在后台标签里）不出声：
  // 那时 Chrome 会把音频上下文挂起，响了也听不见。
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
        vscode.postMessage({ type: "switchSessionByDirection", direction: dir });
      }
      return;
    }
    // 切换会话
    const combos = tabSwitchCombos(tabSwitchKey);
    if (matchCombo(e, combos.prev)) { e.preventDefault(); vscode.postMessage({ type: "switchSessionByDirection", direction: "prev" }); return; }
    if (matchCombo(e, combos.next)) { e.preventDefault(); vscode.postMessage({ type: "switchSessionByDirection", direction: "next" }); return; }
  });

  // ==================== 会话状态 ====================
  function activeSession() { return activeId ? sessions.get(activeId) : null; }

  function createSession(id, title) {
    let st = sessions.get(id);
    if (st) { return st; }
    // 一个会话 = 一层壳（.session-view）：消息窗格 + 底部状态栏。
    // 壳一直留着（切走只是从 #messages 里摘下来），切回去时消息、滚动位置、草稿都还在。
    const view = document.createElement("div");
    view.className = "session-view";
    view.dataset.sessionId = id;
    const pane = document.createElement("div");
    pane.className = "session-pane";
    pane.dataset.sessionId = id;
    pane.innerHTML = '<div class="empty-hint">输入消息开始对话…</div>';
    view.appendChild(pane);
    const stBar = document.createElement("div");
    stBar.className = "pane-status";
    // 拦掉 mousedown 冒泡：状态栏自己处理点击（弹模型选择器）
    stBar.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    stBar.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "pickModel", sessionId: id, t0: performance.now() });
    });
    view.appendChild(stBar);
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
      viewEl: view,
      statusEl: stBar,
      // 后端给的会话元信息（sessionList 每推一次覆盖一次）
      parentId: null,
      taba: null,
      currentAssistant: null,
      // 正在想的那一段（见 startThinking）：这一段还没想完时挂在它身上，增量往它上面加
      thinkingEntry: null,
      // 生成速度统计：本轮累计估算 token 数 / 起点时间；tps 为上一轮最终均值
      tps: undefined,
      tpsStart: 0,
      tpsTokens: 0,
      currentToolRow: null,
      // 这一批（一条工具调用行）里按工具名归拢的合并标签（见 addToolToGroup）：
      // { row, byName }，byName 记 工具名 → 组里那一条；行一换（来了正文）就是新的一批。
      // toolGroupEntries 记 callId → 组里那一条，结果回来时按它找到该更新哪一条。
      toolGroups: null,
      toolGroupEntries: new Map(),
      pendingToolCards: new Map(),
      pendingToolTags: new Map(),
      // 正在重放历史（切会话、重连、加载更早的一批）时不飘 +1：那些是老消息，不是新涨的
      noCountPop: true,
      // 历史窗口（网页端「只发最近一段」）：顶部按钮、加载更早的暂存区等
      hasMoreHistory: false,
      _historyBtn: null,
      _stage: null,
      _stageDropped: false,
      streaming: false,
      unread: false,
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
      autoLoadHinted: false,
    };
    sessions.set(id, st);
    return st;
  }

  /** 把一个会话的壳挂进 #messages（同时把别的摘下来）；已经挂着的就不动。 */
  function mountActiveSession() {
    const target = activeId ? sessions.get(activeId) : null;
    if (target && target.viewEl.parentElement === messagesEl) { return; }
    document.querySelectorAll("#messages .session-view").forEach((el) => {
      if (el.dataset.sessionId !== activeId) { el.remove(); }
    });
    const st = target;
    if (!st) { return; }
    messagesEl.appendChild(st.viewEl);
    // 重挂载后把滚动位置恢复回去（贴底的直接贴底）
    const p = st.paneEl;
    if (st.stickToBottom) {
      st.programmaticScroll = true;
      p.scrollTop = p.scrollHeight;
      st.lastScrollTop = p.scrollTop;
    } else if (typeof st.lastScrollTop === "number") {
      p.scrollTop = st.lastScrollTop;
    }
    // 重挂载会让 CSS 动画重播：剥掉历史气泡的入场动画，避免整窗“抖一下”
    st.viewEl.querySelectorAll(".msg-enter").forEach((el) => { el.classList.remove("msg-enter"); });
  }

  /**
   * 会话在界面上显示的名字：优先用 pi 起的标题（自动命名扩展 / /name 写的，如“上传插件到 GitHub”），
   * 它还没出来时用我们自己的随机名（“沉静的雪豹”）。
   */
  function sessionLabel(st) {
    if (!st) { return "新会话"; }
    return st.piTitle || st.title || "新会话";
  }

  /**
   * 这个会话派出去的子会话里，还有没有在跑的：子会话自己在跑（正在答、或者刚开始
   * 那一轮），或者刚派出去、任务还没发完（taba 那边是 starting）。
   * 顶条中间那颗名字上的小点用它：本会话自己闲着、子会话还在干活时照样亮着呼吸。
   */
  function hasRunningChild(id) {
    return Array.from(sessions.values()).some((s) => {
      if (s.parentId !== id) { return false; }
      if (s.streaming || s.loading) { return true; }
      const state = s.taba ? s.taba.state : "";
      return state === "starting" || state === "running";
    });
  }

  /** 顶条中间那行字：当前会话名（带在跑的小点；主会话多过一个就再挂一颗朝下的小箭头）。 */
  function renderSessionBar() {
    const st = activeId ? sessions.get(activeId) : null;
    const text = sessionLabel(st);
    const textEl = sessionNameBtn.querySelector(".sn-text");
    if (textEl) { textEl.textContent = text; }
    sessionNameBtn.title = "当前会话：" + text + "（点这里换会话）";
    // 名字底下那行小字：当前会话跑在哪个目录（会话在别的项目里开的时候就看得出差别）。
    // 拿不到目录（列表还没到、会话已关）就不占行，顶条高度不跳。
    const dir = st && typeof st.cwd === "string" ? st.cwd : "";
    if (sessionPathTextEl) { sessionPathTextEl.textContent = dir; }
    if (sessionPathEl) {
      sessionPathEl.title = dir;
      sessionPathEl.classList.toggle("hidden", !dir);
    }
    sessionNameBtn.classList.toggle("streaming", !!(st && (st.streaming || st.loading)));
    // 派出去的子会话还在跑：本会话自己闲着也把那颗点亮出来（一样呼吸），
    // 一眼看得出这一家子还在干活（等的是子会话，不是本会话在答）。
    sessionNameBtn.classList.toggle("child-running", !!(st && hasRunningChild(st.id)));
    // 别的会话跑完了你没看（“有新消息”）：名字左边那颗小点亮着，不闪；切过去看就灭。
    // 当前这个会话正在跑时那颗点拿去闪了（streaming 优先），未读还得点开清单看。
    sessionNameBtn.classList.toggle("unread", Array.from(sessions.values()).some((s) => s.unread));
    // 就一个主会话时不必提示“这里能换”（点开还是同一张清单：里面就它自己）
    sessionCaret.classList.toggle("hidden", sessionMenuItems().length < 2);
    // 清单开着的时候它会跟着变（换会话、改标题、某个会话跑完了）：重画完还要重新摆——
    // 内容变宽变窄了，贴着屏幕边的位置就不对了。
    if (sessionMenuOpen) { renderSessionMenu(); placeSessionMenu(); }
  }

  // ==================== 顶条那颗会话名的下拉框 ====================
  // 点顶条中间那颗名字 → 从它下面掉出一张清单，里面是**开着的主会话**，点一行就切过去（不新开、不重载）。
  // 子会话不占这里的行（清单只当主会话的快速切换用）：要看 / 要点进子会话去
  // 「项目与会话」面板的「正在对话」那一段，那里子会话照旧缩进挂在派它的会话下面。
  // 看历史 / 换工作区 / 在别的目录里开会话也走那个面板。
  const sessionMenuEl = document.createElement("div");
  sessionMenuEl.id = "sessionMenu";
  sessionMenuEl.className = "hidden";
  document.body.appendChild(sessionMenuEl);
  let sessionMenuOpen = false;

  /** 把清单贴在中间那一列底下（名字与目录两行都在它上面，清单别盖住目录行）：
   *  先量准宽度，再把整块夹进屏幕里（左右各留 8px）。 */
  function placeSessionMenu() {
    const anchor = (sessionCenterEl || sessionNameBtn).getBoundingClientRect();
    const margin = 8;
    // 量之前先把上一次留下的 left / width 清掉：left 留着会挤小可用宽度、
    // 上一次钉死的 width 会掩盖内容的自然宽度，两种都会把宽度量成错的。
    sessionMenuEl.style.left = "0px";
    sessionMenuEl.style.width = "";
    const room = Math.max(140, window.innerWidth - margin * 2);
    const natural = sessionMenuEl.offsetWidth;
    const width = Math.min(natural, room);
    // 比一屏还宽就在这儿钉住（CSS 的 max-width 会管，但那是以内容盒算的，这里按整块算）
    if (natural > room) { sessionMenuEl.style.width = width + "px"; }
    const wantLeft = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.max(margin, Math.min(wantLeft, window.innerWidth - margin - width));
    sessionMenuEl.style.left = Math.round(left) + "px";
    sessionMenuEl.style.top = Math.round(anchor.bottom + 4) + "px";
  }

  /**
   * 这张清单要列的行：只列主会话（子会话不在标题下拉框里露面）。
   * 父会话已经关掉的子会话会以主会话的身份出现在 openSessionItems() 里（depth 为 0），
   * 那种照列——它已经是一个独立会话了。
   */
  function sessionMenuItems() {
    return openSessionItems().filter((item) => !item.depth);
  }

  /** 画一遍清单内容：开着的主会话一行一个。 */
  function renderSessionMenu() {
    sessionMenuEl.innerHTML = "";
    sessionMenuItems().forEach((item) => {
      const el = document.createElement("div");
      el.className = "sm-item" + (item.current ? " current" : "");
      el.title = (item.label || "") + (item.cwd ? "\n" + item.cwd : "");
      const dot = document.createElement("span");
      dot.className = "sm-dot" + openDotClass(item);
      el.appendChild(dot);
      // 一行两段：上面会话名，下面它跑在哪个目录（子会话不在这个清单里）
      const body = document.createElement("div");
      body.className = "sm-body";
      const name = document.createElement("span");
      name.className = "sm-name";
      name.textContent = item.label || "";
      body.appendChild(name);
      if (item.cwd) {
        const dir = document.createElement("span");
        dir.className = "sm-path";
        dir.textContent = item.cwd;
        body.appendChild(dir);
      }
      el.appendChild(body);
      // 行尾不再挂「当前」/「在跑」：当前那条整行有底色，在跑 / 有新消息看名字前头那颗小点。
      el.addEventListener("click", () => {
        closeSessionMenu();
        if (!item.current) { vscode.postMessage({ type: "switchSession", sessionId: item.sessionId }); }
      });
      sessionMenuEl.appendChild(el);
    });
  }

  function openSessionMenu() {
    // 一个主会话都没有（刚打开、后端还没说话）：没东西可切，不开这张空壳
    if (!sessionMenuItems().length) { return; }
    renderSessionMenu();
    sessionMenuEl.classList.remove("hidden");
    sessionMenuOpen = true;
    placeSessionMenu();
  }

  function closeSessionMenu() {
    if (!sessionMenuOpen) { return; }
    sessionMenuOpen = false;
    sessionMenuEl.classList.add("hidden");
  }

  function toggleSessionMenu() {
    if (sessionMenuOpen) { closeSessionMenu(); return; }
    openSessionMenu();
  }

  // 点别处 / 按 Esc 收起来；窗口尺寸变了重新贴回名字底下。
  document.addEventListener("pointerdown", (e) => {
    if (!sessionMenuOpen) { return; }
    if (sessionMenuEl.contains(e.target) || sessionCenterEl.contains(e.target)) { return; }
    closeSessionMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    // 捕获阶段收掉，别让它顺手把正在生成的这一轮也中止了（Esc 另有中止的用途）
    if (e.key === "Escape" && sessionMenuOpen) { e.stopPropagation(); closeSessionMenu(); }
  }, true);
  window.addEventListener("resize", () => { if (sessionMenuOpen) { placeSessionMenu(); } });

  // 空提示每个窗格只可能有一份：查过一次就记住，别再对着几百条消息的子树反复
  // querySelector（整屏重画时每条消息都查一次，那是 n²；实测占掉打开长会话 11% 的时间）。
  // clear 会把窗格重写成带空提示的一屏，那时重置这个标记（见 clear 分支）。
  function hideEmptyHint(st) {
    if (st.emptyHintGone) { return; }
    st.emptyHintGone = true;
    const hint = st.paneEl.querySelector(".empty-hint");
    if (hint) { hint.remove(); }
  }

  /** 历史会话切换可能要等待 pi 冷启动和读盘；用 pane 内遮罩明确反馈进度。 */
  function syncSessionLoading(st) {
    const existing = st.paneEl.querySelector(":scope > .session-loading");
    if (!st.loading) {
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
    st.paneEl.appendChild(overlay);
  }

  // ==================== 滚动 ====================
  const BOTTOM_THRESHOLD = 40;
  function isNearBottomPane(st) {
    return st.paneEl.scrollHeight - st.paneEl.scrollTop - st.paneEl.clientHeight <= BOTTOM_THRESHOLD;
  }
  function lerpScrollStep(st) {
    if (!st.stickToBottom) { st.lerpRafId = 0; return; }
    const target = st.paneEl.scrollHeight - st.paneEl.clientHeight;
    const cur = st.paneEl.scrollTop;
    const diff = target - cur;
    if (Math.abs(diff) < 1) { st.programmaticScroll = true; st.paneEl.scrollTop = target; st.lerpRafId = 0; return; }
    st.programmaticScroll = true;
    st.paneEl.scrollTop = cur + diff * 0.3;
    st.lerpRafId = requestAnimationFrame(() => lerpScrollStep(st));
  }
  function smoothScrollToBottom(st) {
    // 只对挂在页面上的窗格（当前会话那个）追底
    if (!st.paneEl.isConnected) { return; }
    if (!st.stickToBottom) {
      // 用户不在底部，有新内容到来：标记并显示跳转提示
      st.hasNewContent = true;
      syncJumpBottom(st);
      return;
    }
    if (!st.lerpRafId) { st.lerpRafId = requestAnimationFrame(() => lerpScrollStep(st)); }
  }
  /**
   * 滚到底。两点讲究（都是从“打开长会话要好几秒”那个坑里总结出来的）：
   *   · 不读 scrollHeight：读它会让浏览器立刻做一次完整重排；整屏重画是几百条消息
   *     挨个进来的，每条读一次就是几百次重排（总量是 n²）。给一个足够大的数，
   *     浏览器自己会夹到最大滚动位置。
   *   · 一帧里只滚一次：整屏重画是一个同步循环，中间那些滚动本来就没人看得见。
   */
  function scrollToBottom(st, force) {
    if (!force && !st.stickToBottom) { return; }
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); st.lerpRafId = 0; }
    st.stickToBottom = true;
    st.hasNewContent = false;
    syncJumpBottom(st);
    // 窗格没挂在页面上（「加载更早」那批消息的暂存区、后台会话）时只记状态，不排追底那一帧。
    // 排了的话，等这一帧真跑起来时 paneEl 可能已经换人（暂存区用完就还回真窗格了），
    // 结果滚的是真窗格——点「加载更早」视野就无缘无故甩到底部。
    const pane = st.paneEl;
    if (!pane.isConnected) { return; }
    if (st.scrollRafId) { return; }
    st.scrollRafId = requestAnimationFrame(() => {
      st.scrollRafId = 0;
      if (st.paneEl !== pane || !pane.isConnected) { return; }
      st.programmaticScroll = true;
      pane.scrollTop = 1e9;   // 夹到最大：没有读，就不会逼出一次同步重排
    });
  }
  // 用户主动接管滚动（滚轮/触屏/键盘向上）：立刻停掉 lerp 追底，交还控制权。
  // 流式中同步亮起“跳到最新”按钮；非流式不打扰（用户只是回看已结束的回复）。
  function userTookOverScroll(st) {
    if (!st.stickToBottom) { return; }
    st.stickToBottom = false;
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); st.lerpRafId = 0; }
    if (st.streaming) { st.hasNewContent = true; syncJumpBottom(st); }
  }
  // 控制“跳到最新”按钮显隐（只对当前会话生效）
  function syncJumpBottom(st) {
    if (!jumpBottomBtn) { return; }
    const show = st.hasNewContent && !st.stickToBottom && activeId === st.id;
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
  // ==================== 流式正文：按块渲染 ====================
  // 为什么不是整段重画：整段重画每次都要把全文重新解析、重新高亮、把全部节点换掉，
  // 长回复下越画越贵（手机上能把一颗核心跑满）。这里把正文按顶层块切开：
  //   · 已经定型的块（后面还跟着两块以上的）只渲染一次，以后不再解析也不再动 DOM；
  //   · 只重画尾巴，而且只对尾巴重新切块（不在全文上重跑解析）。
  // 尾巴留两块：没写完的标记（***、#、缩进、表格分隔行）可能把前一块的延续打掉。
  const STREAM_TAIL_BLOCKS = 2;

  /** 从 text 切出顶层块；有不能安全独立成块的（引用式定义、HTML 块）返回 null。 */
  function lexTopBlocks(text) {
    let tokens;
    try { tokens = marked.lexer(text, mdOptions()); } catch (e) { return null; }
    for (const tk of tokens) {
      if (!tk || typeof tk.raw !== "string") { return null; }
      // 引用式定义会影响全文里别的链接/图片；HTML 块里可能有跨块的标签：这两种回退整段渲染
      if (tk.type === "def" || tk.type === "html") { return null; }
    }
    return tokens;
  }

  /** 前 count 个块在原文里共占多少个字符（切块只认原文长度，不靠位置对象）。 */
  function blocksChars(tokens, count) {
    let n = 0;
    for (let i = 0; i < count; i++) { n += tokens[i].raw.length; }
    return n;
  }

  /** 渲染一个块：空格块不产节点（块级元素自带外边距，空行没有视觉）。 */
  function buildStreamBlock(token) {
    const box = document.createElement("div");
    box.className = "md-block";
    const html = streamBlockHtml(token);
    if (html === null) { return null; }
    box.innerHTML = html;
    return box;
  }

  /** 一个块渲染成的 HTML；空格块给 null。 */
  function streamBlockHtml(token) {
    if (token.type === "space") { return null; }
    ensureMarkedHighlight();
    ensureFileLink();
    try { return marked.parser([token], mdOptions()); } catch (e) { return escapedText(token.raw); }
  }
  function escapedText(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }

  /**
   * 把流式正文按块同步进 cur.el。返回 false 表示这次不能按块渲染（调用方退回整段）。
   * 状态记在 cur.blocks 上：tokens（本轮全部块）、frozenCount / frozenOffset（已定型到哪儿）、
   * els（每个块对应的容器，与 tokens 下标一一对应，空格块是 null）。
   */
  function syncStreamBlocks(cur, raw) {
    let state = cur.blocks;
    if (state && raw.length < state.rawLen) { state = null; }   // 正文变短（不是追加）：从头来
    if (!state) {
      cur.el.textContent = "";
      state = cur.blocks = { tokens: [], frozenCount: 0, frozenOffset: 0, els: [], rawLen: 0 };
    }

    // 只重新切尾巴：冻结部分不再进解析器
    const tailTokens = lexTopBlocks(raw.slice(state.frozenOffset));
    if (!tailTokens) { return false; }
    const tokens = state.tokens.slice(0, state.frozenCount).concat(tailTokens);
    // 冻结线：留最后两块不冻。只增不退：块数变少时（尾巴合并了）不把已冻结的收回来
    const freeze = Math.max(state.frozenCount, tokens.length - STREAM_TAIL_BLOCKS);

    // 尾巴：内容与上一轮一字不差的块留着容器，其余重画
    const frozenEls = state.els.slice(0, state.frozenCount);
    const tailEls = [];
    for (let i = state.frozenCount; i < tokens.length; i++) {
      const old = state.tokens[i];
      const oldEl = state.els[i];
      if (old && oldEl && oldEl.parentElement === cur.el && old.type === tokens[i].type && old.raw === tokens[i].raw) {
        tailEls.push(oldEl);
      } else {
        tailEls.push(buildStreamBlock(tokens[i]));
      }
    }
    // 旧的尾巴容器：没被复用的删掉
    for (let i = state.frozenCount; i < state.els.length; i++) {
      const el = state.els[i];
      if (el && el.parentElement === cur.el && tailEls.indexOf(el) < 0) { el.remove(); }
    }
    // 按顺序接上（复用的容器跟着挪到末尾，顺序就对了）
    for (const el of tailEls) { if (el) { cur.el.appendChild(el); } }

    state.frozenOffset += blocksChars(tailTokens, freeze - state.frozenCount);
    state.els = frozenEls.concat(tailEls);
    state.tokens = tokens;
    state.frozenCount = freeze;
    state.rawLen = raw.length;
    return true;
  }

  /** 渲染流式正文（按块；不能切块时回退整段重画）。 */
  function renderStreamBody(st, raw) {
    const cur = st.currentAssistant;
    cur.el.dataset.raw = raw;
    if (syncStreamBlocks(cur, raw)) { return; }
    cur.blocks = null;
    cur.el.innerHTML = renderMarkdown(raw);
  }

  function scheduleFlush(st) { if (!st.rafId) { st.rafId = requestAnimationFrame(() => flushDeltas(st)); } }
  function flushDeltas(st) {
    st.rafId = 0;
    const now = performance.now();
    if (st.textDirty && st.currentAssistant) {
      const raw = st.currentAssistant.raw || "";
      const interval = renderInterval(raw.length);
      if (interval > 0 && now - st.lastRenderAt < interval) {
        st.rafId = requestAnimationFrame(() => flushDeltas(st));
      } else if (activeId === st.id && isSelectingIn(st.currentAssistant.el)) {
        st.rafId = requestAnimationFrame(() => flushDeltas(st));
      } else {
        renderStreamBody(st, raw);
        st.lastRenderAt = now;
        st.textDirty = false;
      }
    }
    smoothScrollToBottom(st);
  }
  function cancelFlush(st) { if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = 0; } st.textDirty = false; }
  function finalizeCurrentAssistant(st) {
    cancelFlush(st);
    if (st.currentAssistant) {
      st.currentAssistant.el.innerHTML = renderMarkdown(st.currentAssistant.raw || "");
      st.currentAssistant.el.dataset.raw = st.currentAssistant.raw || "";
      smoothScrollToBottom(st);
      st.currentAssistant = null;
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

  function addPlain(st, cls, role, text) {
    hideEmptyHint(st);
    st.currentToolRow = null; // 新消息块：工具标签另起一行，不往上一段后面续
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
    st.paneEl.appendChild(div);
    scrollToBottom(st);
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

  function addMarkdown(st, raw) {
    hideEmptyHint(st);
    st.currentToolRow = null; // 新正文块：工具标签另起一行，不往上一段后面续
    const div = document.createElement("div");
    div.className = "msg assistant msg-enter";
    const body = document.createElement("div");
    body.className = "md";
    body.dataset.raw = raw || "";
    body.innerHTML = renderMarkdown(raw || "");
    attachCopyBtn(div, () => body.dataset.raw || "");
    div.appendChild(body);
    st.paneEl.appendChild(div);
    scrollToBottom(st);
    return body;
  }

  /** 工具标签挂载点：所有工具调用单独占一行，跟正文分开（这是要求，别再把标签接回正文段落里）；
   *  同一批（两条正文之间的）调用收拢在同一个 .tool-row 里，下一条正文到来时另起一行；
   *  一条放不下的就折行（见 chat.css 的 .tool-row）。 */
  function toolTagHost(st) {
    // 行还有效吗：判定不看 isConnected —— 整屏重放发生在窗格被挂进页面之前
    // （刷新后 sessionList / 重画先到、窗格后挂），那会儿 pane 里所有节点 isConnected 都是 false，
    // 每个标签都会被误判"行没了"而各自新建一行，重放出来的工具调用就竖着排了。
    // 看爹更可靠：行被收掉（图块收编后删空行）或 pane 被清空（innerHTML 重写）时爹就没了。
    if (!st.currentToolRow || st.currentToolRow.parentElement !== st.paneEl) {
      st.currentToolRow = document.createElement("div");
      st.currentToolRow.className = "msg tool-row msg-enter";
        st.paneEl.appendChild(st.currentToolRow);
    }
    return st.currentToolRow;
  }

  /** 把标签挂进这条工具调用行。 */
  function mountToolTag(st, tag) {
    toolTagHost(st).appendChild(tag);
  }

  /** 标签的悬浮/点按触发：触屏点一下显示、再点一下（或点外面）关闭；电脑悬浮显示，
   *  从标签移进提示框不收，两边都离开才收（见 scheduleTagTipHide）。
   *  单个标签、编辑卡片标签、合并标签共用这一套。 */
  function attachTagTipHandlers(tag) {
    if (IS_TOUCH_DEVICE) {
      tag.addEventListener("click", () => {
        if (tagTipTag === tag) { hideTagTip(); } else { showTagTip(tag); }
      });
    } else {
      tag.addEventListener("mouseenter", () => showTagTip(tag));
      tag.addEventListener("mouseleave", scheduleTagTipHide);
    }
  }

  // ==================== 工具标签：合并 ====================
  // 一条工具调用行（= 两条正文之间的一批）里，同一个工具名只出一个标签：工具名 + 次数小方块（这批里一共调了几次，
  // 只有一次时不写数字）。标签就停在**第一次**出现这个名字的位置；中间夹了别的工具调用（不同名的、
  // 或者编辑卡片）不影响它攒数，数都记在同一个标签上。
  // 鼠标停上去，提示框里把它们一条一条列出来（调用 + 结果），见 fillGroupTip。
  //
  // 不合并的（每次单独一个标签，连着来也各占一个）：
  //   · taba / taba_stop / taba_peek（派子会话）—— 每次派的活不一样，各自单独看一眼更清楚；
  //   · write / edit —— 本来就不是小标签，是带 diff 的卡片（见 buildEditCard）；
  //   · 结果带图的 read —— 是不是图要等结果回来才知道，那条到了会从组里摘出去，
  //     在对话里铺成一整块图（见 removeEntryFromGroup）。
  // 一条正文（或用户消息）到来就换行、另起一批，上批的标签不再攒数。
  const NO_MERGE_TOOLS = new Set(["write", "edit", "taba", "taba_stop", "taba_peek"]);
  const GROUP_RUNNING_TEXT = "运行中…";
  /** 模型的思考也算这一批里的一种条目：名字固定叫这个（不并进 NO_MERGE_TOOLS：同名照常合并）。 */
  const THINKING_NAME = "think";

  function addTool(st, toolName, argStr, toolCallId) {
    hideEmptyHint(st);
    if (!NO_MERGE_TOOLS.has(toolName)) { addToolToGroup(st, toolName, argStr, toolCallId); return; }
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
    attachTagTipHandlers(tag);
    mountToolTag(st, tag);
    if (toolCallId) { st.pendingToolTags.set(toolCallId, tag); }
    scrollToBottom(st);
  }

  /** 往这一批里加一条调用：同名就并到已有那个标签上（标签停在第一次调用的位置），
   *  没见过的名字新开一个标签。 */
  function addToolToGroup(st, toolName, argStr, toolCallId) {
    const row = toolTagHost(st);
    let batch = st.toolGroups;
    if (!batch || batch.row !== row) {
      batch = { row, byName: new Map() };
      st.toolGroups = batch;
    }
    let g = batch.byName.get(toolName);
    if (!g || g.tag.parentElement !== row) {
      const tag = document.createElement("span");
      tag.className = "tool tool-group";
      tag.insertAdjacentHTML("afterbegin", GEAR_SVG);
      const nameEl = document.createElement("span");
      nameEl.className = "tg-name";
      const countEl = document.createElement("span");
      countEl.className = "tg-count";
      tag.appendChild(nameEl);
      tag.appendChild(countEl);
      // 合并标签上不挂单条结果（_toolName / _resultText 那一套）：每条的数据都在 g.entries 里
      // plusAt / plusEl：这条标签上「+1」小动画的上一次时间与正在飘的那个（见 popPlusOne）
      g = { row, tag, nameEl, countEl, name: toolName, entries: [], plusAt: 0, plusEl: null };
      tag._tipFill = (content) => fillGroupTip(g, content);
      attachTagTipHandlers(tag);
      batch.byName.set(toolName, g);
      mountToolTag(st, tag);
    }
    const entry = {
      group: g,
      id: toolCallId || "",
      name: toolName,
      argStr: argStr || "",
      tipCall: tagTipCallText(toolName, argStr),
      resultText: "",
      meta: {},
      isError: false,
      done: !toolCallId, // 无 id 的静态调用无结果事件，按已完成处理
    };
    g.entries.push(entry);
    if (toolCallId) { st.toolGroupEntries.set(toolCallId, entry); }
    syncGroupTag(g);
    // 方块上飘个 +1：只有“本来就是它、又攒了一条”才飘，重放历史时（noCountPop）不飘
    if (g.entries.length > 1 && !st.noCountPop) { popPlusOne(g); }
    scrollToBottom(st);
    return entry;
  }

  // 同一颗标签上「+1」最快隔这么久才飘一次：连着一串调用时不至于一直跳
  const PLUS_MIN_GAP_MS = 600;

  /** 次数方块上飘一个「+1」：从方块上方浮起来一点、淡掉，飘完自己从页面上收走。
   *  锚在标签里（标签自己是 position: relative），不占布局位置、不挡鼠标。
   *  同一颗标签上有间隔限制（PLUS_MIN_GAP_MS）：太密就不飘，免得一串调用看得人眼花。 */
  function popPlusOne(g) {
    const count = g.countEl;
    if (!count || !count.offsetWidth) { return; }
    const now = Date.now();
    if (now - (g.plusAt || 0) < PLUS_MIN_GAP_MS) { return; }
    g.plusAt = now;
    if (g.plusEl) { g.plusEl.remove(); }   // 上一个还在飘：换成新的，重新从底下飘一遍
    const pop = document.createElement("span");
    pop.className = "tg-plus";
    pop.textContent = "+1";
    g.tag.appendChild(pop);
    pop.style.left = (count.offsetLeft + count.offsetWidth / 2) + "px";
    pop.style.top = (count.offsetTop - (pop.offsetHeight || 10) - 1) + "px";   // 方块正上方，不盖住数字
    g.plusEl = pop;
    setTimeout(() => { pop.remove(); if (g.plusEl === pop) { g.plusEl = null; } }, 900);
  }

  /** 合并标签长什么样：工具名 + 次数（一个写着数字的小方块；只调一次就不写数字）；
   *  有一条还在跑就转圈，有失败就标红。 */
  function syncGroupTag(g) {
    g.nameEl.textContent = " " + (g.name || "");
    const total = g.entries.length;
    g.countEl.textContent = total > 1 ? String(total) : "";
    g.tag.classList.toggle("running", g.entries.some((e) => !e.done));
    g.tag.classList.toggle("error", g.entries.some((e) => e.isError));
    refreshTagTipIfShowing(g.tag);
  }

  /** 合并标签的提示内容：一条调用一行（输入），下面紧跟它的结果（输出），一条条排下来。 */
  function fillGroupTip(g, content) {
    content.textContent = "";
    g.entries.forEach((e, i) => {
      const call = document.createElement("div");
      call.className = "tag-tip-call" + (i > 0 ? " tag-tip-call-next" : "");
      call.textContent = e.tipCall || e.name;
      content.appendChild(call);
      const res = document.createElement("div");
      if (e.done) {
        res.className = "tag-tip-result";
        res.textContent = e.resultText || "（没有输出）";
      } else if (e.resultText) {
        // 还在跑、但已经拿到部分结果（toolResultUpdate）：先把拿到的部分显示出来
        res.className = "tag-tip-result tip-loading";
        res.textContent = e.resultText;
      } else {
        res.className = "tag-tip-result tip-loading";
        res.textContent = GROUP_RUNNING_TEXT;
      }
      content.appendChild(res);
    });
  }

  /** 结果带图（read 读图这类）：把这一条从合并组里摘出去，在对话里铺成一整块图。
   *  组被摘空了就连标签带那条工具行一起收掉，后面的调用会另起一行、另起一组。 */
  function removeEntryFromGroup(st, entry, images) {
    const g = entry.group;
    const i = g.entries.indexOf(entry);
    if (i >= 0) { g.entries.splice(i, 1); }
    st.toolGroupEntries.delete(entry.id);
    if (g.entries.length === 0) {
      const row = g.tag.parentElement;
      g.tag.remove();
      const batch = st.toolGroups;
      if (batch && batch.byName.get(g.name) === g) { batch.byName.delete(g.name); }
      dropToolRow(st, row);
    } else {
      syncGroupTag(g);
    }
    mountToolImageBlock(st, { toolName: entry.name, argStr: entry.argStr, tipCall: entry.tipCall }, images);
  }

  /** 收掉一个工具标签；它所在那条工具行空了就连行一起收掉（不留空行）。 */
  function dropToolTag(st, tag) {
    const row = tag.parentElement;
    tag.remove();
    dropToolRow(st, row);
  }
  function dropToolRow(st, row) {
    if (row && row !== st.paneEl && row.classList.contains("tool-row") && row.childElementCount === 0) { row.remove(); }
  }

  // ==================== 思考 ====================
  // 模型的思考（reasoning）也算这一批条目里的一种：名字固定「think」，跟同名工具一样合并成一个标签，
  // 内容只在提示框里看（标签上不露文字）。正在想的那一段挂在 st.thinkingEntry 上，
  // 增量来一条往它上面加一条；收尾见 endThinking。

  /** 模型开始想了：在工具行里开出「think」这个条目（已经在想就直接用现成的那条）。 */
  function startThinking(st) {
    if (st.thinkingEntry) { return st.thinkingEntry; }
    hideEmptyHint(st);
    const entry = addToolToGroup(st, THINKING_NAME, "", "");
    // 没有 callId 的条目默认按完成（见 addToolToGroup）：这一段落还在跑，得改回来
    entry.done = false;
    entry.tipCall = THINKING_NAME;
    st.thinkingEntry = entry;
    syncGroupTag(entry.group);
    return entry;
  }

  /** 想完一段：整段文本补上、标签停住。历史重放只来一条全文（没有开始事件），这里现开一个再收尾。
   *  forceNew：往暂存区补更早的历史时用（正在想的那一条在真的窗格里，别动它）。 */
  function endThinking(st, text, forceNew) {
    let entry = forceNew ? null : st.thinkingEntry;
    if (!entry) {
      if (!text) { return; }   // 没在想的、又没有文本（重复收尾）：不用管
      entry = addToolToGroup(st, THINKING_NAME, "", "");
      entry.tipCall = THINKING_NAME;
    }
    if (st.thinkingEntry === entry) { st.thinkingEntry = null; }
    entry.done = true;
    if (text) { entry.resultText = text; }
    syncGroupTag(entry.group);
    scrollToBottom(st);
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
   * 工具结果带图片（read 读图这类）：把这条调用换成对话里的一整块 ——
   * 上面一行说明（齿轮 + 工具名 / 文件名，图片尺寸到了再补上），下面把图完整铺出来。
   *
   * 为什么不用悬浮提示：图藏在提示框里要鼠标悬上去才看得到，而"读了哪张图"本身就是对话内容。
   * 块自己占一行（不跟正文挤在同一行里）；原来那个小标签由调用方先收掉（见 dropToolTag /
   * removeEntryFromGroup），那条工具行空了也一并收掉，后面的工具调用会另起一行重新排
   * （见 toolTagHost）。调用方传 at：{ toolName, argStr, tipCall }。
   */
  function mountToolImageBlock(st, at, images) {
    if (!Array.isArray(images) || images.length === 0) { return; }
    const call = at || {};
    const block = document.createElement("div");
    block.className = "tool-image-block msg-enter";
    const head = document.createElement("div");
    head.className = "tib-head";
    head.insertAdjacentHTML("afterbegin", GEAR_SVG);
    const text = document.createElement("span");
    text.className = "tib-text";
    // 说明行只写文件名（整条路径太长，把图片挤下去了）；想看完整路径就把鼠标停在上面
    const name = call.toolName || "";
    const file = fileNameFromArgs(call.argStr);
    text.textContent = name && file ? (name + " " + file) : (call.tipCall || name);
    text.title = call.tipCall || text.textContent;
    head.appendChild(text);
    block.appendChild(head);
    // 图直接接在说明行下面；图加载完成后尺寸会写回说明行（见 applyImageDims）
    renderResultImages(block, images, block);
    st.paneEl.appendChild(block);
    scrollToBottom(st);
  }

  /** 卡片结果区渲染：预览截断（尾部 N 行，同 TUI）+ 元信息 + 展开/收起。 */
  function renderDiffBlock(st, diffText, filePath) {
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
          vscode.postMessage({ type: "openEditLocation", sessionId: st.id, path: filePath, line: target, anchor });
        });
      }
      inner.appendChild(div);
    }
    return wrap;
  }

  function buildEditCard(st, toolName, label, filePath, toolCallId, argStr) {
    hideEmptyHint(st);
    // 收起态：跟普通工具调用一样的「齿轮 + 工具名」小标签，收进那条工具调用行；文件路径在悬浮提示里看。
    const pill = document.createElement("span");
    pill.className = "tool et-pill" + (toolCallId ? " running" : "");
    pill.insertAdjacentHTML("afterbegin", GEAR_SVG);
    pill.appendChild(document.createTextNode(" " + toolName));
    attachTagTipHandlers(pill);
    mountToolTag(st, pill);
    scrollToBottom(st);

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
            content.appendChild(renderDiffBlock(st, pendingResult.diff, filePath));
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
            revertBtn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "revertEdit", sessionId: st.id, toolCallId }); });
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

    // 与普通工具标签同一套触发（见 attachTagTipHandlers）

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
  function renderQueueBar(st) {
    if (activeId !== st.id) { return; }
    const items = st.queuedSteering || [];
    if (!items.length) { queueBarEl.classList.add("hidden"); queueBarEl.innerHTML = ""; return; }
    queueBarEl.classList.remove("hidden");
    queueBarEl.innerHTML = "";
    items.forEach((text) => {
      const full = typeof text === "string" ? text : "";
      const lines = full.split("\n");
      const preview = lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n…" : "");
      const card = document.createElement("div");
      card.className = "qb-block collapsed";
      const head = document.createElement("div");
      head.className = "qb-head";
      head.title = "点击展开或收起排队消息";
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-expanded", "false");
      const dot = document.createElement("span"); dot.className = "qb-dot";
      const previewLine = document.createElement("span"); previewLine.className = "qb-preview";
      previewLine.textContent = (lines[0] || "").trim();
      const body = document.createElement("pre"); body.className = "qb-body";
      body.textContent = preview;
      const toggle = () => {
        const collapsed = card.classList.toggle("collapsed");
        head.setAttribute("aria-expanded", String(!collapsed));
        body.textContent = collapsed ? preview : full;
      };
      head.appendChild(dot); head.appendChild(previewLine);
      card.appendChild(head); card.appendChild(body);
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
      });
      queueBarEl.appendChild(card);
    });
  }

  // ==================== UI 同步（当前会话驱动全局控件）====================
  /** 当前会话在不在生成：Esc 中止与输入框角上那颗“停止生成”按钮共用这一处判断。 */
  function activeSessionStreaming() {
    const st = activeSession();
    return !!(st && st.streaming);
  }

  /**
   * 输入框右下角那颗小按钮：生成中是“停止生成”，空闲时是“继续”——两颗共用一个位置，
   * 同一时刻只露面一颗。两颗都是 browserBridge.js 建的（两种页面里都有）。
   */
  function syncComposerButtons() {
    const st = activeSession();
    const streaming = !!(st && st.streaming);
    // 会话还没就绪（pi 进程刚起）或正在加载会话时，点了也发不出去：这时候不出“继续”。
    const canContinue = !!(st && st.piReady && !st.loading && !streaming);
    if (continueBtn) {
      continueBtn.classList.toggle("hidden", !canContinue);
      // “继续”带字、比停止图标宽：露面时输入框右边的留白要跟着加宽（见 browserTheme.css）
      if (continueBtn.parentElement) { continueBtn.parentElement.classList.toggle("has-continue", canContinue); }
    }
    if (stopBtn) {
      stopBtn.classList.toggle("hidden", !streaming);
      stopBtn.disabled = false;
    }
  }

  function updateSendState() {
    // VSCode 里发送/中止只看键盘（Enter 发送、Esc 中止），没有按钮；状态文案由 syncStatus 负责。
    // 网页端（尤其手机）没有 Esc：输入框角上那颗按钮随当前会话换脸——生成中是“停止生成”，
    // 闲着且会话能收消息时是“继续”。
    syncComposerButtons();
  }
  // 状态栏常显模型：这些纯函数拼出模型名前缀与用量百分比标签。
  function modelPartFor(st) {
    const id = (st && st.modelId) || "";
    const prov = (st && st.provider) || "";
    return id ? ((prov ? prov + "/" : "") + id) : "";
  }
  let tpsSyncAt = 0;
  // delta 高频到达，速度刷新做 250ms 节流（当前会话的状态栏要刷）
  function noteTpsProgress(t) {
    if (!t.paneEl.isConnected) { return; }
    const now = Date.now();
    if (now - tpsSyncAt >= 250) { tpsSyncAt = now; if (activeId === t.id) { syncStatus(); } syncPaneStatuses(); }
  }
  function pctTag(st) {
    if (!st || typeof st.percent !== "number") { return ""; }
    const cls = st.percent >= 90 ? " err" : (st.percent >= 70 ? " warn" : "");
    return '<span class="st-pct' + cls + '">' + st.percent.toFixed(1) + '%</span>';
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
  function currentTps(st) {
    if (!st) { return undefined; }
    if (st.streaming && st.tpsStart > 0 && st.tpsTokens > 0) {
      const secs = (Date.now() - st.tpsStart) / 1000;
      return secs > 0.3 ? (st.tpsTokens / secs) : undefined;
    }
    return st.tps;
  }
  function statusTags(st) {
    const parts = [];
    const mp = modelPartFor(st);
    if (mp) { parts.push('<span class="st-model">' + mp + (st.thinkingLevel ? "/" + st.thinkingLevel : "") + '</span>'); }
    const pct = pctTag(st);
    if (pct) { parts.push(pct); }
    const tps = currentTps(st);
    if (typeof tps === "number") { parts.push('<span class="st-tps">' + tps.toFixed(1) + ' t/s</span>'); }
    return parts;
  }
  // 状态栏已全部下沉到每个 panel 底部（.pane-status）；此别名保留既有调用点。
  function syncStatus() { syncPaneStatuses(); }

  /** 附件预览：随会话级草稿（图片 / 折叠文本块与输入文字同层）。 */
  function renderAttachmentsFor() {
    const d = draftOfSession();
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

  function draftOfSession() {
    if (!sessionDrafts.has(activeId)) {
      sessionDrafts.set(activeId, { text: "", selStart: 0, selEnd: 0, images: [], textBlocks: [] });
    }
    const d = sessionDrafts.get(activeId);
    if (!Array.isArray(d.images)) { d.images = []; }
    if (!Array.isArray(d.textBlocks)) { d.textBlocks = []; }
    return d;
  }
  function saveInputState() {
    const d = draftOfSession();
    d.text = inputEl.value;
    d.selStart = inputEl.selectionStart;
    d.selEnd = inputEl.selectionEnd;
  }
  /**
   * 页面刚打开那一两秒还没有会话，输入区里的字记在“还没有会话”那份草稿（键是 null）下。
   * 第一个会话出现时要把它搬过去：不然切过去会加载空草稿，把刚打的字冲掉
   * （表现为“打开界面马上打字，字自己没了”）。输入框里的实时内容以输入框为准，
   * 附件（粘的图、折叠文本块）在草稿里。
   */
  function carryComposerToSession(sessionId) {
    const pending = sessionDrafts.get(null);
    sessionDrafts.set(sessionId, {
      text: inputEl.value,
      selStart: inputEl.selectionStart,
      selEnd: inputEl.selectionEnd,
      images: (pending && pending.images) || [],
      textBlocks: (pending && pending.textBlocks) || [],
    });
    sessionDrafts.delete(null);
  }
  function restoreInputState() {
    const d = draftOfSession();
    inputEl.value = d.text || "";
    // 高度按当前内容重算（autoResize）：草稿里不存高度——存下来的那个可能是
    // 另一个窗口宽度下算出来的，用在这儿要么矮一截（冒滚动条）、要么空一大块。
    autoResize();
    try {
      inputEl.setSelectionRange(d.selStart || 0, d.selEnd || 0);
    } catch { /* ignore */ }
    renderAttachmentsFor();
    hideFileMenu();
  }

  function reflectSessionUI() {
    const st = activeSession();
    if (!st) { return; }
    updateSendState();
    syncStatus();
    renderQueueBar(st);
    syncJumpBottom(st);
  }

  /** 一个会话底部状态栏的 HTML。 */
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

  /** 刷新所有会话的底部状态栏内容与当前高亮。 */
  function syncPaneStatuses() {
    sessions.forEach((t) => {
      const el = t.statusEl;
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

  // ==================== 切换会话 ====================
  // 触屏设备（手机/平板）上切会话不要自动聚焦输入框：程序聚焦会把输入法拉起来，
  // 键盘挡住半屏。电脑上保持原行为：切完焦点落在输入框，直接能打字。
  const IS_TOUCH_DEVICE = (function () {
    try { return window.matchMedia("(hover: none) and (pointer: coarse)").matches; }
    catch { return false; }
  })();
  /** 切到某个会话：把它的壳挂回 #messages，草稿跟着换（打了一半的字留在各自会话里）。 */
  function activateSessionView(id) {
    if (!sessions.has(id) || activeId === id) { return; }
    hideTagTip();
    if (activeId !== null) { saveInputState(); } else { carryComposerToSession(id); }
    activeId = id;
    // 看过了：那颗“有新消息”的小蓝点收掉
    const shown = sessions.get(id);
    if (shown && shown.unread) { shown.unread = false; }
    mountActiveSession();
    restoreInputState();
    reflectSessionUI();
    renderSessionBar();
    refreshOpenSessionsInPicker();
    if (!IS_TOUCH_DEVICE) { inputEl.focus(); }
    // 切到这个会话：排在"还没有会话"名下的消息现在有主了，能发就发
    flushPendingSend();
  }

  /** 这份会话文件是不是有会话正开着（列表里把这种历史行标成“已打开”）。 */
  function sessionOpenForFile(file) {
    if (!file) { return false; }
    const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
    const want = norm(file);
    for (const st of sessions.values()) {
      if (st.sessionFile && norm(st.sessionFile) === want) { return true; }
    }
    return false;
  }

  /** 两个目录是不是同一个（斜杠、末尾斜杠、大小写都归一化再比）。 */
  function sameDir(a, b) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return norm(a) === norm(b);
  }

  /**
   * 「正在对话」这些行列首那颗小点的样式名（顶条下拉框与面板共用同一套）：
   * 在跑＝蓝点呼吸，出错＝红点，有新消息（未读）＝蓝点不闪，其余不显示。
   */
  function openDotClass(item) {
    if (item.streaming || item.loading) { return " running"; }
    if (item.taba && item.taba.state === "error") { return " error"; }
    return item.unread ? " unread" : "";
  }

  /**
   * 会话列表里「正在对话」那一段的行：主会话在前，子会话缩进挂在它下面。
   * 数据取自本地这份状态（列表是浮层，内容由宿主给；这一段只有界面自己知道）。
   *
   * @param folder 只列跑在这个目录里的会话（「项目与会话」面板跟着当前显示的
   *               工作区走）；不传就是全部开着的会话（顶条那颗会话名的下拉用）。
   */
  function openSessionItems(folder) {
    const ordered = sessionOrder.map((id) => sessions.get(id)).filter(Boolean);
    const items = [];
    const push = (st, depth) => {
      items.push({
        __section: "open",
        sessionId: st.id,
        label: sessionLabel(st),
        section: "正在对话",
        current: st.id === activeId,
        streaming: !!st.streaming,
        loading: !!st.loading,
        unread: !!st.unread,
        taba: st.taba || null,
        depth,
        pendingClose: pendingCloseId === st.id,
        // 下拉框里第二行显示它跑在哪个目录（同名会话靠它分辨）
        cwd: st.cwd || "",
      });
    };
    ordered.forEach((st) => {
      // 子会话不单独占一行：挂在父会话下面（缩进一格）
      if (st.parentId && sessions.has(st.parentId)) { return; }
      const kids = ordered.filter((kid) => kid.parentId === st.id);
      // 一家子只要有一个跑在这个目录里就整家一起列：子会话可能被派到别的目录里去跑
      if (folder && !sameDir(st.cwd, folder) && !kids.some((kid) => sameDir(kid.cwd, folder))) { return; }
      push(st, 0);
      kids.forEach((kid) => { push(kid, 1); });
    });
    return items;
  }

  /** 请求关闭某个会话：第一次点击只是把那一行变成确认条，再点一下才真关（防误触）。 */
  function askCloseSession(id) {
    if (pendingCloseId !== id) {
      pendingCloseId = id;
      if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
      pendingCloseTimer = setTimeout(() => {
        pendingCloseId = null;
        pendingCloseTimer = null;
        refreshOpenSessionsInPicker();
      }, 4000);
      refreshOpenSessionsInPicker();
      return;
    }
    if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
    pendingCloseTimer = null;
    pendingCloseId = null;
    // 列表不关：关掉一条后马上就能接着关下一条（那一行会跟着会话列表自己消失）
    vscode.postMessage({ type: "closeSession", sessionId: id });
  }

  /**
   * 「正在对话」那一段的内容指纹（只算真会影响列表长相的字段）。
   * 带上开着的会话各自是哪个文件：上半那些「历史会话」行靠它标「已打开」。
   */
  function openSessionsSignature(items) {
    const files = Array.from(sessions.values()).map((t) => t.sessionFile || "").sort().join(",");
    return files + "\u0000" + items.map((it) => [
      it.sessionId, it.label || "", it.depth || 0, it.current ? 1 : 0,
      it.streaming ? 1 : 0, it.loading ? 1 : 0, it.unread ? 1 : 0,
      (it.taba && it.taba.state) || "", it.pendingClose ? 1 : 0,
    ].join("|")).join("\n");
  }
  /** 界面上正画着的那份「正在对话」内容的指纹（见上面那个函数）。 */
  let openSessionsShown = "";

  /**
   * 会话增减 / 状态变化 / 确认条状态变化：列表开着就重画一遍。
   * 两处讲究：
   *  - 只换「正在对话」那一段，后面原样接回去——「加载更多」追加进来的行只存在 st.items 里，
   *    不能拿宿主最初给的那份数据整份重拼，否则点出来的行会被下一次状态推送抹掉；
   *  - 内容跟屏幕上那份一模一样就不画：会话在跑的时候状态推送很密，
   *    白白重画一遍只会把滚动位置顶回顶部。
   */
  function refreshOpenSessionsInPicker() {
    const st = pickerState;
    if (!st || (st.kind !== "workspace" && st.kind !== "history")) { return; }
    // 「项目与会话」面板只列当前显示的工作区里的会话；历史抽屉没有工作区这个概念，列全部。
    const openItems = openSessionItems(st.kind === "workspace" ? st.folder : "");
    const signature = openSessionsSignature(openItems);
    if (signature === openSessionsShown) { return; }
    openSessionsShown = signature;
    // 「新建会话」那一行固定在最前：它跟「正在对话」同一个分组，不能跟着会话一起被换到后面去。
    const rest = st.items.filter((it) => it.__section !== "open" && it.__section !== "openNew");
    st.items = (st.newSessionItem ? [st.newSessionItem] : []).concat(openItems, rest);
    renderPickerItems();
  }


  // ==================== 通用拾取器浮层（模型 / 历史）====================
  function hidePicker() {
    pickerOverlay.classList.add("hidden");
    pickerOverlay.classList.remove("pk-drawer");
    pickerOverlay.classList.remove("pk-workspace");
    pickerOverlay.classList.remove("pk-folders");
    pickerBody.innerHTML = "";
    pickerSearch.value = "";
    if (pickerInput && pickerInputWrap) {
      pickerInput.value = "";
      pickerInputWrap.classList.add("hidden");
      if (document.activeElement === pickerInput) { pickerInput.blur(); }
    }
    setPickerSubtitle("");
    pickerFooter.innerHTML = "";
    pickerFooter.classList.add("hidden");
    pickerFooter.classList.remove("pk-model-footer");
    pickerFooter.classList.remove("pk-history-footer");
    pickerFooter.classList.remove("pk-question-footer");
    const leftoverClose = document.getElementById("pickerClose");
    if (leftoverClose) { leftoverClose.remove(); }
    pickerSearchWrap.classList.remove("hidden");
    // “关闭会话”的确认条只在列表里有效：列表一关就撤销（下次打开不要停在确认态）
    if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
    pendingCloseTimer = null;
    pendingCloseId = null;
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
    } else if (kind === "folders" || kind === "workspace") {
      // 文件夹 / 项目与会话：名字和路径都能搜（手机上找项目时往往记得路径里的一个词）。
      hay.push(item.label || "", item.folderPath || "");
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
  /**
   * 问话（多选）底下那一行：左边说勾了几项，右边「取消 / 确定」。
   * 单选不用这个 —— 点一行就是答案，没有“下一步”。
   */
  function renderQuestionFooter(st) {
    pickerFooter.innerHTML = "";
    pickerFooter.classList.remove("hidden");
    pickerFooter.classList.add("pk-question-footer");
    const summary = document.createElement("div"); summary.className = "pk-footer-summary";
    const written = String(pickerInput && pickerInput.value || "").trim();
    summary.textContent = st.picked.size > 0
      ? "已勾 " + st.picked.size + " 项"
      : (written ? "按上面写的交回去" : "一项都没勾");
    pickerFooter.appendChild(summary);
    const actions = document.createElement("div"); actions.className = "pk-footer-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => cancelPicker());
    actions.appendChild(cancelBtn);
    const okBtn = document.createElement("button");
    okBtn.type = "button"; okBtn.className = "primary"; okBtn.textContent = "确定";
    okBtn.addEventListener("click", () => submitQuestion());
    actions.appendChild(okBtn);
    pickerFooter.appendChild(actions);
  }

  /**
   * 问话：把勾中的项和“自己写”的那句一起交回去。两样都可能是空的 —— 都空等于没作答，
   * 模型那边收到的就是“用户没作答”（跟按取消一个意思）。
   */
  function submitQuestion() {
    const st = pickerState; if (!st) { return; }
    const picks = Array.from(st.picked);
    const text = String(pickerInput && pickerInput.value || "").trim();
    hidePicker();
    vscode.postMessage({ type: "pickerChoice", kind: "question", payload: { picks, text } });
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
    // 重画前先把滚动位置记下来（渲染完再放回去）：会话状态推送一来就会重画一遍，
    // 不能把人正看着的那一段顶回顶部。会话 / 工作区两块各滚各的，分开记。
    const prevSessionPane = pickerBody.querySelector(".pk-session-pane");
    const prevSpacePane = pickerBody.querySelector(".pk-space-pane");
    const keepScroll = {
      body: pickerBody.scrollTop,
      session: prevSessionPane ? prevSessionPane.scrollTop : 0,
      space: prevSpacePane ? prevSpacePane.scrollTop : 0,
    };
    pickerBody.innerHTML = "";
    pickerBody.classList.toggle("pk-workspace-body", st.kind === "workspace");
    let sessionPane = null;
    let spacePane = null;
    /** 渲染完把滚动位置放回原处（内容变短时浏览器自己会夹到最底下）。 */
    const restoreScroll = () => {
      pickerBody.scrollTop = keepScroll.body;
      if (sessionPane) { sessionPane.scrollTop = keepScroll.session; }
      if (spacePane) { spacePane.scrollTop = keepScroll.space; }
    };
    if (st.kind === "workspace") {
      sessionPane = document.createElement("div"); sessionPane.className = "pk-workspace-pane pk-session-pane";
      spacePane = document.createElement("div"); spacePane.className = "pk-workspace-pane pk-space-pane";
      pickerBody.appendChild(sessionPane); pickerBody.appendChild(spacePane);
    }
    if (st.filtered.length === 0) {
      const empty = document.createElement("div"); empty.className = "pk-empty";
      empty.textContent = q ? "没有匹配项。" : "列表为空。";
      pickerBody.appendChild(empty);
      if ((st.kind === "history" || st.kind === "workspace") && st.historyHasMore) { pickerBody.appendChild(buildLoadMoreBtn(st, "sessions")); }
      if (st.kind === "model") { renderModelFooter(st); }
      restoreScroll();
      return;
    }
    let lastSection = null;
    let lastModelProv = null;
    /** 项目与会话面板里「加载更多」已经插过了吗（它要卡在会话那块的末尾）。 */
    let loadMorePlaced = false;
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

      const sectionPane = st.kind === "workspace" && item.__section === "space" ? spacePane : sessionPane;
      // “项目与会话”面板：会话的「加载更多」必须放在会话末尾、工作区标题之前，
      // 否则看起来会像是工作区的操作。
      if (st.kind === "workspace" && item.__section === "space" && !loadMorePlaced) {
        loadMorePlaced = true;
        if (st.historyHasMore) { sessionPane.appendChild(buildLoadMoreBtn(st, "sessions")); }
      }
      if (item.section && item.section !== lastSection) {
        lastSection = item.section;
        const sep = document.createElement("div"); sep.className = "pk-section";
        sep.textContent = item.section;
        (sectionPane || pickerBody).appendChild(sep);
      }
      const el = document.createElement("div");
      el.className = "pk-item" + (idx === st.sel ? " active" : "");
      if (st.kind === "question") {
        // 问话的选项行：多选前面一颗方框（勾上/没勾），单选不加标记（靠行上的高亮）；
        // 推荐的那几项挂一个小标记。
        const t = document.createElement("div"); t.className = "pk-title";
        const checked = st.picked.has(String(item.label || ""));
        if (st.multi) {
          const box = document.createElement("span"); box.className = "pk-check" + (checked ? " on" : "");
          box.innerHTML = checked ? ICONS.check : "";
          t.appendChild(box);
        }
        t.appendChild(document.createTextNode(String(item.label || "")));
        if (st.recommended.indexOf(idx + 1) >= 0) {
          const badge = document.createElement("span"); badge.className = "pk-recommend"; badge.textContent = "我推荐";
          t.appendChild(badge);
        }
        el.appendChild(t);
        if (checked) { el.classList.add("pk-picked"); }
      } else if (st.kind === "workspace" && item.__section === "space") {
        el.classList.add("pk-space");
      } else if (st.kind === "workspace" && item.__section === "session") {
        el.classList.add("pk-session");
      }
      if (item.__section === "openNew") {
        // 「正在对话」那组里的「＋ 在 xxx 新建会话」：在这个面板当前显示的目录里开新会话。
        el.classList.add("pk-history", "pk-action");
        const main = document.createElement("div"); main.className = "pk-history-main";
        const icon = document.createElement("span"); icon.className = "pk-row-icon"; icon.innerHTML = ICONS.add;
        main.appendChild(icon);
        const title = document.createElement("span"); title.className = "pk-history-title";
        title.textContent = "在 " + (item.name || item.folder) + " 新建会话";
        main.appendChild(title);
        el.appendChild(main);
        el.title = "在 " + item.folder + " 新建会话";
      } else if (item.__section === "open") {
        // 「正在对话」：开着的会话（子会话缩进挂在主会话下面）。
        // 主会话只有在建会话、当前会话、在跑的才加粗 / 点蓝；历史列表里那套字号不动。
        el.classList.add("pk-history", "pk-open");
        if (item.current) { el.classList.add("current"); }
        if (item.depth > 0) { el.classList.add("pk-open-child"); }
        if (item.pendingClose) {
          el.classList.add("pk-open-confirm");
          const bar = document.createElement("div"); bar.className = "pk-open-bar";
          const ask = document.createElement("span"); ask.className = "pk-open-ask";
          ask.textContent = "关闭「" + (item.label || "") + "」？";
          bar.appendChild(ask);
          const yes = document.createElement("button");
          yes.type = "button"; yes.className = "pk-open-yes"; yes.textContent = "关闭";
          yes.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(item.sessionId); });
          const no = document.createElement("button");
          no.type = "button"; no.className = "pk-open-no"; no.textContent = "取消";
          no.addEventListener("click", (e) => {
            e.stopPropagation();
            pendingCloseId = null;
            if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
            pendingCloseTimer = null;
            refreshOpenSessionsInPicker();
          });
          bar.appendChild(yes); bar.appendChild(no);
          el.appendChild(bar);
        } else {
          const main = document.createElement("div"); main.className = "pk-history-main";
          // 子会话：名字前面挂一个拐角箭头（“↳”），一眼看出它是挂在上面那个会话下面的
          if (item.depth > 0) {
            const arrow = document.createElement("span");
            arrow.className = "pk-open-arrow";
            arrow.innerHTML = ICONS.child;
            main.appendChild(arrow);
          }
          const dot = document.createElement("span");
          dot.className = "pk-open-dot" + openDotClass(item);
          main.appendChild(dot);
          const title = document.createElement("span"); title.className = "pk-history-title"; title.textContent = item.label || "";
          main.appendChild(title);
          // 行尾不再挂「当前」/「在跑」：当前那条靠整行的底色认，在跑 / 有新消息靠行首那颗小点。
          el.appendChild(main);
          // 关闭按钮放行尾：点行是切过去（大目标），点这颗才关（还要再确认一下）。
          const close = document.createElement("span");
          close.className = "pk-open-close";
          close.title = "关闭这个会话";
          close.setAttribute("aria-label", "关闭这个会话");
          close.innerHTML = ICONS["close-bold"];
          close.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(item.sessionId); });
          el.appendChild(close);
        }
        el.title = item.label || "";
      } else if (st.kind === "history" || (st.kind === "workspace" && item.__section === "session")) {
        el.classList.add("pk-history");
        if (item.current) { el.classList.add("current"); }
        const main = document.createElement("div"); main.className = "pk-history-main";
        const title = document.createElement("span"); title.className = "pk-history-title"; title.textContent = item.title || "(无消息)";
        main.appendChild(title);
        const right = document.createElement("span"); right.className = "pk-history-right";
        // 已经开着的会话（在「正在对话」里已经有一行）：标一下，免得看着像两条不同的会话。
        if (sessionOpenForFile(item.file)) {
          const open = document.createElement("span"); open.className = "pk-open-tag"; open.textContent = "已打开";
          right.appendChild(open);
        }
        // 条数为 0 不显示（空目录工作区挂着个“0”只有噪声）。
        if (item.count > 0) { const count = document.createElement("span"); count.className = "pk-history-count"; count.textContent = String(item.count); right.appendChild(count); }
        if (item.lastActivity) { const age = document.createElement("span"); age.className = "pk-history-age"; age.textContent = pickerRelTime(item.lastActivity); right.appendChild(age); }
        if (right.childNodes.length) { main.appendChild(right); }
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
      } else if (st.kind === "workspace" && item.__section === "space") {
        // 工作区行：文件夹图标 + 名字一行，路径另起一行弱化（全路径长，但它就是辨认同名目录的关键）。
        el.classList.add("pk-history");
        if (item.current) { el.classList.add("current"); }
        const main = document.createElement("div"); main.className = "pk-history-main";
        const icon = document.createElement("span"); icon.className = "pk-row-icon"; icon.innerHTML = ICONS.folder;
        main.appendChild(icon);
        if (item.action === "browse") {
          // 「浏览文件夹…」动作行：强调色，附注一行说明它干什么。
          el.classList.add("pk-action");
          const title = document.createElement("span"); title.className = "pk-history-title"; title.textContent = item.label || "";
          main.appendChild(title);
          el.appendChild(main);
          if (item.folderPath) { const d = document.createElement("div"); d.className = "pk-browse-desc"; d.textContent = item.folderPath; el.appendChild(d); }
        } else {
          const title = document.createElement("span"); title.className = "pk-history-title"; title.textContent = item.label || "";
          main.appendChild(title);
          const right = document.createElement("span"); right.className = "pk-history-right";
          if (item.count > 0) { const c = document.createElement("span"); c.className = "pk-history-count"; c.textContent = String(item.count); right.appendChild(c); }
          if (item.lastActivity) { const a = document.createElement("span"); a.className = "pk-history-age"; a.textContent = pickerRelTime(item.lastActivity); right.appendChild(a); }
          if (right.childNodes.length) { main.appendChild(right); }
          el.appendChild(main);
          if (item.folderPath) { const p = document.createElement("div"); p.className = "pk-space-path"; p.textContent = item.folderPath; el.appendChild(p); }
        }
        el.title = item.folderPath || item.label || "";
      } else if (st.kind === "folders") {
        // 文件夹行按资源管理器的样子画：行首一格图标 + 名字一行。
        // 正在看的是哪个目录写在标题下面那行小字里（宿主的 subtitle），行里不再重复。
        el.classList.add("pk-history");
        const main = document.createElement("div"); main.className = "pk-history-main";
        const iconHtml = FOLDER_ROW_ICONS[item.icon];
        if (iconHtml) {
          const icon = document.createElement("span"); icon.className = "pk-row-icon";
          icon.innerHTML = iconHtml; main.appendChild(icon);
        }
        const title = document.createElement("span"); title.className = "pk-history-title";
        title.textContent = item.label || "";
        main.appendChild(title);
        el.appendChild(main);
        el.title = item.label || "";
      }
      // 其他种类（没有专属排版的）：直接渲染标题。
      // 问话（question）有自己那一段（前面画过了），不能在这儿再画一遍。
      if (["history", "options", "workspace", "folders", "question"].indexOf(st.kind) < 0 && item.label) {
        const t = document.createElement("div"); t.className = "pk-title";
        t.textContent = String(item.label);
        el.appendChild(t);
      }
      el.addEventListener("mouseenter", () => { st.sel = idx; renderPickerActive(); });
      el.addEventListener("click", () => { confirmPicker(idx); });
      (sectionPane || pickerBody).appendChild(el);
    });
    // 两个面板各有自己的滚动区和加载按钮。
    if (st.kind === "history" && st.historyHasMore) {
      pickerBody.appendChild(buildLoadMoreBtn(st, "sessions"));
    }
    if (st.kind === "workspace" && st.historyHasMore && !loadMorePlaced) {
      sessionPane.appendChild(buildLoadMoreBtn(st, "sessions"));
    }
    if (st.kind === "workspace" && st.spacesHasMore) {
      spacePane.appendChild(buildLoadMoreBtn(st, "spaces"));
    }
    if (st.kind === "model") { renderModelFooter(st); }
    if (st.kind === "question" && st.multi) { renderQuestionFooter(st); }
    restoreScroll();
  }
  /**
   * 「加载更多」那颗按钮。which = "sessions" 是上半会话那块的，"spaces" 是下半工作区那块的；
   * 两块各记各的加载中状态（同时点也不会互相把按钮弄乱）。
   */
  function buildLoadMoreBtn(st, which) {
    const isSpaces = which === "spaces";
    const loading = isSpaces ? st.spacesLoading : st.historyLoading;
    const btn = document.createElement("button");
    btn.className = "pk-loadmore";
    btn.textContent = loading ? "加载中…" : "加载更多";
    btn.disabled = !!loading;
    btn.addEventListener("click", () => {
      if (loading) { return; }
      if (isSpaces) { st.spacesLoading = true; } else { st.historyLoading = true; }
      renderPickerItems();
      vscode.postMessage({ type: isSpaces ? "workspaceLoadMore" : "historyLoadMore" });
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
    // 问话（ask_choice）：单选点一行就是答案；多选点一下勾上 / 再点取消，勾完按底下的「确定」。
    if (kind === "question") {
      if (!st.multi) {
        hidePicker();
        vscode.postMessage({ type: "pickerChoice", kind, payload: { picks: [String(item.label || "")], text: "" } });
        return;
      }
      const key = String(item.label || "");
      if (st.picked.has(key)) { st.picked.delete(key); } else { st.picked.add(key); }
      renderPickerItems();
      return;
    }
    if (st.toggle || item.behavior === "toggle") {
      vscode.postMessage({ type: "pickerToggle", kind, action: item.action, value: item.value });
      return;
    }
    // 「正在对话」那组里的「＋ 在 xxx 新建会话」：收起面板、就在这个目录里开一个
    // （宿主按面板当前显示的工作区开，不是后端启动时那个默认目录）。
    if (item.__section === "openNew") {
      hidePicker();
      // 目录明写在消息里：面板可能同时在两块屏上开着，后端记的“当前工作区”是最后一人换的那个，
      // 不能拿它当这块屏上写着的那一个。
      vscode.postMessage({ type: "newSessionInWorkspace", path: item.folder });
      return;
    }
    // 「正在对话」段：点行就是切过去（不新开、不重载），行尾那颗 × 是关闭（要再点一下确认）。
    if (item.__section === "open") {
      if (item.pendingClose) { askCloseSession(item.sessionId); return; }
      hidePicker();
      vscode.postMessage({ type: "switchSession", sessionId: item.sessionId });
      return;
    }
    // “项目与会话”面板：点下半的工作区**不关面板**，只让宿主把上半那份会话列表换成它的；
    // “浏览文件夹…”那一行例外（它不是工作区，是要跳去文件夹面板）。
    if (kind === "workspace" && item.__section === "space" && item.action !== "browse") {
      vscode.postMessage({ type: "workspacePick", path: item.file });
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
  /**
   * “项目与会话”面板：宿主给的是两块（会话 / 工作区），这里拉平成一个数组交给通用渲染。
   * 会话在前、工作区在后；每行记着自己是哪一块（__section），下面渲染分行、
   * 点行为也不一样（点会话关面板切过去，点工作区只换上半）。
   */
  function workspaceFlatItems(msg) {
    const ss = (msg.sessions && Array.isArray(msg.sessions.items)) ? msg.sessions.items : [];
    const sp = (msg.spaces && Array.isArray(msg.spaces.items)) ? msg.spaces.items : [];
    const head = HISTORY_SECTION;
    const withSection = (it, sec, headText) => {
      const copy = {};
      for (const k in it) { if (Object.prototype.hasOwnProperty.call(it, k)) { copy[k] = it[k]; } }
      copy.__section = sec;
      copy.section = headText;
      return copy;
    };
    return ss.map((it) => withSection(it, "session", head))
      .concat(sp.map((it) => withSection(it, "space", "工作区")));
  }

  function renderPicker(msg) {
    const kind = msg.kind;
    const toggle = !!msg.toggle;
    // 面板与顶条那颗下拉是同一个位置上的两种界面：开面板就把下拉收掉。
    closeSessionMenu();
    // “项目与会话”面板不放搜索框：上半会话、下半工作区两块结构，这个框帮不上忙还占一截
    // （要找项目看路径就行）；历史面板的搜索留着。
    const searchable = msg.searchable !== false && !toggle && kind !== "workspace";
    // 宿主给的这一半（磁盘上的历史会话 / 工作区）和界面自己拼的「正在对话」合成一份：
    // 之后就只换「正在对话」那一段（见 refreshOpenSessionsInPicker），
    // 免得把「加载更多」追加进来的行弄丢。
    // 历史抽屉里磁盘上那批会话也归成一节（「历史会话」）：没有这一节，它们会并到
    // 「正在对话」底下，看着像是那些开着的会话的续行。
    const rawHostItems = Array.isArray(msg.items) ? msg.items : [];
    const hostItems = kind === "workspace" ? workspaceFlatItems(msg)
      : (kind === "history" ? rawHostItems.map((it) => (it.section ? it : Object.assign({}, it, { section: HISTORY_SECTION }))) : rawHostItems);
    // 「项目与会话」面板当前显示的是哪个工作区（切工作区时宿主会重发一份，这里跟着换）：
    // 上半「正在对话」只列这个目录里开着的会话，那颗「在 xxx 新建会话」也在这个目录里开。
    const folder = kind === "workspace"
      ? String((msg.sessions && msg.sessions.folder) || (msg.spaces && msg.spaces.current) || "")
      : "";
    const newSessionItem = kind === "workspace" && folder
      ? { __section: "openNew", section: "正在对话", folder, name: (msg.sessions && msg.sessions.name) || folder }
      : null;
    const openItems = (kind === "workspace" || kind === "history") ? openSessionItems(folder) : [];
    // 刚画出来的「正在对话」长什么样：之后状态推送内容没变就不重画（见 refreshOpenSessionsInPicker）
    openSessionsShown = openSessionsSignature(openItems);
    pickerState = {
      kind,
      folder,
      newSessionItem,
      items: (newSessionItem ? [newSessionItem] : []).concat(openItems, hostItems),
      filtered: [],
      sel: kind === "model" ? -1 : 0,
      current: msg.current || null,
      draftModel: null,
      draftThinking: undefined,
      toggle,
      // 问话（ask_choice）：能勾多个吗、推荐哪几项（从 1 数起）、已勾中了哪几项。
      // 单选点一行就是答案；多选点一下勾上，勾完按底下的「确定」。
      multi: kind === "question" && msg.multi === true,
      recommended: kind === "question" && Array.isArray(msg.recommended) ? msg.recommended : [],
      picked: new Set(),
      // 「加载更多」：history 看 msg.hasMore，项目与会话分两块（会话 sessions.hasMore、工作区 spaces.hasMore）。
      historyHasMore: kind === "workspace" ? !!(msg.sessions && msg.sessions.hasMore) : msg.hasMore === true,
      historyLoading: false,
      spacesHasMore: kind === "workspace" ? !!(msg.spaces && msg.spaces.hasMore) : false,
      spacesLoading: false,
    };
    // 抽屉列表刚打开时不预选任何一行：哪条会话是“当前”由行尾那颗胶囊说，
    // 预选只会给那一行铺一层灰底（.pk-item.active），看着像又选中了一条。
    // 上下键按下去才出现选中行（sel 从 -1 开头，取首/末的那段见 ArrowDown / ArrowUp）。
    if (kind === "workspace" || kind === "history") {
      pickerState.sel = -1;
    }
    const titleMap = { model: "切换模型", history: "会话历史", options: "显示选项" };
    pickerTitle.textContent = titleMap[kind] || (typeof msg.title === "string" && msg.title ? msg.title : "选择");
    // 标题下面那行小字（现在只有文件夹选择器用：正在看的是哪个目录）；没有就收起来
    setPickerSubtitle(typeof msg.subtitle === "string" ? msg.subtitle : "");
    if (kind === "question" && pickerState.multi) {
      // 多选交回去得按一下（单选是点一行就走）：这句告诉人家勾完怎么办
      setPickerSubtitle("可多选：点一下勾上（再点取消），勾完按「确定」");
    }
    pickerSearch.value = "";
    pickerSearchWrap.classList.toggle("hidden", !searchable);
    // 「选一个」这种浮层（pi 扩展问的选项题）：列表底下来一行自由填写。
    // 选项是短的、可能不齐，想写别的就在这一行写，回车就当答案交回去。
    // 底下这一行“自己写”只有问话（ask_choice）用。
    const freeText = kind === "question" && msg.allowText !== false;
    if (pickerInput && pickerInputWrap) {
      pickerInput.value = "";
      pickerInputWrap.classList.toggle("hidden", !freeText);
    }
    pickerFooter.classList.remove("pk-model-footer");
    pickerFooter.classList.remove("pk-history-footer");
    pickerFooter.classList.remove("pk-question-footer");
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
    } else if (kind === "history" || kind === "workspace") {
      // 历史会话 / 项目与会话面板：头部加一颗关闭按钮（面板占满整屏高，窄屏幕上遮罩只剩
      // 一条缝，点不到），底部留一行「设置」——点它先收起面板，再打开设置浮层。
      pickerFooter.classList.remove("hidden");
      pickerFooter.classList.add("pk-history-footer");
      // 面板重画（切换工作区、追加数据走 renderPicker）不会先过 hidePicker，
      // 头部的关闭按钮是 append 进去的：先把旧的那颗摘掉，不然越摘越多。
      const staleClose = document.getElementById("pickerClose");
      if (staleClose) { staleClose.remove(); }
      const headerClose = document.createElement("button");
      headerClose.type = "button"; headerClose.id = "pickerClose";
      headerClose.title = "关闭 (Esc)"; headerClose.setAttribute("aria-label", "关闭");
      headerClose.innerHTML = ICONS["close-bold"];
      headerClose.addEventListener("click", () => cancelPicker());
      pickerHeader.appendChild(headerClose);
      const settingsBtn = document.createElement("button"); settingsBtn.type = "button";
      settingsBtn.className = "secondary pk-footer-settings";
      settingsBtn.title = "打开设置";
      settingsBtn.innerHTML = ICONS.sliders + "<span>设置</span>";
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
    // 历史会话与项目与会话从右侧滑进来（整屏高的面板）；其余拾取器照旧居中弹出
    pickerOverlay.classList.toggle("pk-drawer", kind === "history" || kind === "workspace");
    pickerOverlay.classList.toggle("pk-workspace", kind === "workspace");
    // 文件夹选择器：不给筛选框那一截地方，列表按资源管理器的密度与排版画
    pickerOverlay.classList.toggle("pk-folders", kind === "folders");
    renderPickerItems();
    pickerOverlay.classList.remove("hidden");
    // 计时：若宿主回显了 t0，输出点击 → picker 可见的往返耗时（多 panel 卡顿排查用）
    if (typeof msg.t0 === "number") {
      console.log("[pi] picker(" + kind + ") 点击→弹出: " + Math.round(performance.now() - msg.t0) + "ms");
    }
    if (searchable) { setTimeout(() => pickerSearch.focus(), 0); }
    else if (freeText && pickerInput) { setTimeout(() => pickerInput.focus(), 0); }
  }
  pickerOverlay.addEventListener("click", (e) => { if (e.target === pickerOverlay) { cancelPicker(); } });
  pickerSearch.addEventListener("input", () => {
    if (!pickerState) { return; }
    pickerState.sel = pickerState.kind === "model" ? -1 : 0;
    renderPickerItems();
  });
  // 问话（多选）：在底下那行写字时，底下那句“已勾 / 一项都没勾”跟着变
  if (pickerInput) {
    pickerInput.addEventListener("input", () => {
      if (pickerState && pickerState.kind === "question" && pickerState.multi) { renderQuestionFooter(pickerState); }
    });
  }
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
        // 收回这只浮层，同时把这条按键就地处掉：后面那个 document 上的监听会用 Esc 中止
        // 正在生成的那一轮，它开头那句“浮层开着就跳开”的判断这会儿已经被 cancelPicker 改掉了
        // （两个监听都在 document 上，按注册顺序跑，靠 stopImmediatePropagation 拦下来才管用）。
        e.stopImmediatePropagation();
        cancelPicker();
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); if (st.filtered.length) { st.sel = st.sel < 0 ? 0 : (st.sel + 1) % st.filtered.length; renderPickerActive(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (st.filtered.length) { st.sel = st.sel < 0 ? st.filtered.length - 1 : (st.sel - 1 + st.filtered.length) % st.filtered.length; renderPickerActive(); } }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (st.kind === "question") {
        // 问话：多选交回去（勾中的 + 上面写的）；单选就是高亮那一行 ——
        // 上面写了字就当“自己写的答案”。
        if (st.multi) { submitQuestion(); return; }
        if (pickerInput && document.activeElement === pickerInput && pickerInput.value.trim()) { submitQuestion(); return; }
        confirmPicker(st.sel);
        return;
      }
      // 自由填写那一行只有问话有（上面已经处理完了）：能走到这儿就是高亮那一项
      confirmPicker(st.sel);
    }
    // 多选：空格勾上 / 取消光标停的那一行（在下面那行写字时空格还是空格）
    else if (e.key === " " && st.kind === "question" && st.multi && document.activeElement !== pickerInput) { e.preventDefault(); confirmPicker(st.sel); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancelPicker(); }
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

  // ==================== # 会话引用（给模型别的会话的记录文件路径） ====================
  let hashMatches = [];   // [{id, label, sub}]：「引用哪个会话的记录文件」的候选（子会话用 sub 标注）
  let hashSel = 0;
  let hashStart = -1;     // # 触发字符在输入框的位置
  let hashOpen = false;
  let hashReqSeq = 0;
  // 宿主下发的全局目录：覆盖插件里的对话面板和所有当前打开的编辑器 Pi Chat。
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

  /** # 引用候选由扩展统一下发（含所有会话）；自己正在看的那个不用列进去。 */
  function hashMenuItems() {
    return chatReferences.filter((it) => it.id !== activeId);
  }

  function filterHashMenu(query) {
    const q = (query || "").toLowerCase();
    const all = hashMenuItems();
    // 会话名字和内容都能筛（子会话那一行带着“子会话 · 父会话名”的附注，也能被父名命中）
    hashMatches = q
      ? all.filter((it) => (it.label + " " + (it.sub || "")).toLowerCase().includes(q))
      : all;
    hashSel = 0;
    renderHashMenu();
  }

  function renderHashMenu() {
    if (!hashMatches.length) { fileMenuEl.classList.add("hidden"); return; }
    fileMenuEl.innerHTML = "";
    hashMatches.forEach((it, idx) => {
      const item = document.createElement("div");
      item.className = "file-item" + (idx === hashSel ? " active" : "");
      const kindIcon = document.createElement("span"); kindIcon.className = "hash-kind";
      kindIcon.innerHTML = ICONS.comment;
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
    vscode.postMessage({ type: "fetchChat", sessionId: it.id, requestId: hashReqSeq });
  }

  /** fetchChatResult：会话内容入草稿卡片（标题/体积由宿主算好）。 */
  function applyFetchChatResult(msg) {
    if (msg.requestId !== hashReqSeq) { return; }   // 过期 / 竞态结果丢弃
    if (!activeSession()) { return; }
    const d = draftOfSession();
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
    const style = getComputedStyle(inputEl);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    // VSCode 输入框是 content-box；网页输入框是 border-box，30px 必须包含内边距和边框。
    // scrollHeight 包含内边距、不包含边框，所以两种盒模型需要换算成各自的 height 值。
    const height = style.boxSizing === "border-box"
      ? inputEl.scrollHeight + border
      : inputEl.scrollHeight - padding;
    inputEl.style.height = Math.min(Math.max(height, INPUT_MIN_HEIGHT), 640) + "px";
  }

  // 宽度变了（VSCode 里拖插件面板的边、浏览器里改窗口大小）：同一段字会折成不同的行数，
  // 高度得跟着重算——不然框比内容矮一截，右边就冒出一根滚动条。拖动会连发很多次，一帧合一次。
  let autoResizeFrame = 0;
  window.addEventListener("resize", () => {
    if (autoResizeFrame) { return; }
    autoResizeFrame = requestAnimationFrame(() => { autoResizeFrame = 0; autoResize(); });
  });
  function shouldFoldText(text) {
    if (typeof text !== "string" || !text) { return false; }
    if (text.length > BIG_TEXT_CHARS) { return true; }
    return countLines(text) > BIG_TEXT_LINES;
  }
  // ==================== 会话没就绪时按的回车 ====================
  // 刚打开界面的一两秒里，pi 进程还在起（会话还没就绪）。这时候按回车，
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
    const st = activeSession();
    if (!st || !st.piReady) { return; }
    const text = pendingAutoSend;
    pendingAutoSend = null;
    // 等待期间用户又改了输入框内容：那是他新的意思，不替他发
    if (inputEl.value.trim() !== text.trim()) { return; }
    send();
  }

  /** 宿主替用户发一条（命令入口用）：跟输入框回车完全同一条路。 */
  function sendFromHost(text) {
    if (typeof text !== "string" || text === "") { return; }
    inputEl.value = text;
    send();
  }

  function send() {
    const st = activeSession();
    const d = draftOfSession();
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
    if (!st || !st.piReady) {
      pendingAutoSend = text;
      return;
    }
    pendingAutoSend = null;
    vscode.postMessage({ type: "send", sessionId: st.id, text, images: d.images });
    resetComposer(d);
  }

  /** 发出去（真的发出去）以后把输入区恢复原样。 */
  function resetComposer(d) {
    inputEl.value = "";
    // 高度按空内容重算（autoResize），不要写死 INPUT_MIN_HEIGHT：
    // 那是高度的下限，字号大一点时一行空内容就比它高，写死的话右边会冒出一根滚动条。
    autoResize();
    d.text = "";
    d.images = [];
    d.textBlocks = [];
    hideFileMenu(); hideHashMenu(); closeSlashMenu(); fileMenuEl.classList.add("hidden");
    renderAttachmentsFor();
  }

  // ==================== 事件绑定 ====================
  if (jumpBottomBtn) {
    jumpBottomBtn.addEventListener("click", () => {
      const st = activeSession();
      if (st) { scrollToBottom(st, true); }
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
    const pane = e.target.closest(".session-pane");
    if (!pane) { return; }
    const t = sessions.get(pane.dataset.sessionId);
    if (!t) { return; }
    if (e.deltaY < 0) { userTookOverScroll(t); }
  }, { passive: true });
  messagesEl.addEventListener("touchstart", (e) => {
    const pane = e.target.closest(".session-pane");
    if (!pane) { return; }
    const t = sessions.get(pane.dataset.sessionId);
    if (t) { userTookOverScroll(t); }
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (activeId === null) { return; }
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") { return; }
    const t = sessions.get(activeId);
    if (!t) { return; }
    const k = (e.key || "");
    if (k === "PageUp" || k === "ArrowUp" || k === "Home" || k === " ") { userTookOverScroll(t); }
  }, { passive: true });

  // 流式生成中中止：停掉当前会话正在跑的这一轮
  function abortActiveTab() {
    if (!activeSessionStreaming()) { return false; }
    const focus = sessions.get(activeId);
    if (focus) { focus.pendingSteerRestore = (focus.queuedSteering || []).slice(); }
    vscode.postMessage({ type: "abort", sessionId: activeId });
    return true;
  }

  // 输入框角上那颗“继续”：点一下直接发一条“继续”。
  // 不走 send()：那条路发的是输入框里的内容，还会把输入框清空——打了一半的字得留着。
  if (continueBtn) {
    continueBtn.addEventListener("click", () => {
      const st = activeSession();
      // 这颗按钮只在会话就绪且闲着时露面，这里是防手快点到的边界情况（刚开始生成的那一下）
      if (!st || !st.piReady || st.loading || st.streaming) { return; }
      vscode.postMessage({ type: "send", sessionId: st.id, text: "继续", images: [] });
      // 焦点还回输入框：留在按钮上的话，接着按回车会又点一次这颗按钮
      if (!IS_TOUCH_DEVICE) { inputEl.focus(); }
    });
  }

  // 网页端：点输入框里那颗“停止生成”图标 = 给当前会话按 Esc。
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (!abortActiveTab()) { syncComposerButtons(); return; }
      // 先藏起来并禁用，等宿主的 streamEnd 回来再由 updateSendState 按真实状态刷新；
      // 万一点击没送到（连接断了），过一会儿按真实状态重新算：还在生成就把图标放回来。
      stopBtn.disabled = true;
      stopBtn.classList.add("hidden");
      setTimeout(syncComposerButtons, 1500);
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
    if (e.key === "Escape") {
      // 浮层开着的时候这条键归浮层（收回它）：别顺手把正在生成的那一轮也中止了。
      // 这里只管“不中止”，收回浮层由 document 上那个监听做。
      if (pickerState && !pickerOverlay.classList.contains("hidden")) { return; }
      if (abortActiveTab()) { e.preventDefault(); }
      return;
    }
    if (isSendKey(e)) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", () => { autoResize(); maybeShowFileMenu(); maybeShowHashMenu(); maybeShowSlashMenu(); });
  inputEl.addEventListener("blur", () => { setTimeout(() => { hideFileMenu(); hideHashMenu(); closeSlashMenu(); fileMenuEl.classList.add("hidden"); }, 150); });
  inputEl.addEventListener("paste", (e) => {
    if (!activeSession()) { return; }
    const d = draftOfSession();
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

  // 初始：等待后端推送 sessionList / sessionActivated

  /**
   * 某个会话有新消息了（它跑完一轮时你没有在看它）：名字那颗小蓝点亮着，不闪。
   * 切过去看就灭（见 activateSessionView）。三处都跟着变：顶条、标题下拉框、面板。
   */
  function markSessionUnread(st) {
    if (st.unread) { return; }
    st.unread = true;
    renderSessionBar();
    refreshOpenSessionsInPicker();
  }

  function setStreaming(st, on) {
    st.streaming = on;
    if (activeId === st.id) { updateSendState(); syncStatus(); }
    renderSessionBar();
    syncPaneStatuses();
    refreshOpenSessionsInPicker();
  }
  function setActivity(st, activity, detail) {
    st.activity = activity || (st.streaming ? "working" : "idle");
    st.activityDetail = detail || "";
    if (activeId === st.id) { syncStatus(); }
    syncPaneStatuses();
    refreshOpenSessionsInPicker();
  }
  function setPiReady(st, on, force) {
    st.piReady = on;
    if (activeId === st.id) { updateSendState(); syncStatus(); }
    syncPaneStatuses();
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

    if (type === "sessionList") {
      const incoming = msg.sessions || [];
      const seen = new Set();
      const order = [];
      incoming.forEach((s) => {
        seen.add(s.id);
        order.push(s.id);
        let st = sessions.get(s.id);
        if (!st) {
          st = createSession(s.id, s.name || "新会话");
        } else if (s.name) {
          st.title = s.name;
        }
        st.parentId = s.parentId || null;
        // pi 起的标题（没有就空串）；界面上显示名字的地方一律走 sessionLabel()
        st.piTitle = typeof s.title === "string" ? s.title : "";
        st.streaming = !!s.streaming;
        const incomingActivity = s.activity;
        st.activity = incomingActivity === "working" || incomingActivity === "thinking" || incomingActivity === "tool" || incomingActivity === "idle"
          ? incomingActivity
          : (st.streaming ? "working" : "idle");
        st.activityDetail = typeof s.activityDetail === "string" ? s.activityDetail : "";
        st.piReady = s.piReady !== false;
        st.loading = !!s.loading;
        syncSessionLoading(st);
        // 界面重建（网页重连、视图隐藏重开、窗口重载）后 sessionList 是唯一信源：
        // modelChanged 是一次性推送，不在此恢复会导致状态栏模型名丢失。
        // 字段缺失（后端尚未拿到）时保留本地已有值。
        if (typeof s.modelId === "string") { st.modelId = s.modelId; }
        if (typeof s.provider === "string") { st.provider = s.provider; }
        if (typeof s.thinkingLevel === "string") { st.thinkingLevel = s.thinkingLevel; }
        if (typeof s.percent === "number") { st.percent = s.percent; }
        // 派子会话：这个会话是子会话、或者它派过子会话（列表里据此画标记与缩进）
        st.taba = s.taba || null;
        // 当前用的会话文件（用来把列表里的历史行标成“已打开”）；路径比法两边同归一化
        st.sessionFile = typeof s.file === "string" ? s.file : "";
        // 这个会话跑在哪个目录：面板里按它把会话归到当前显示的那个工作区下面
        st.cwd = typeof s.cwd === "string" ? s.cwd : "";
      });
      sessionOrder = order;
      // 已经不在列表里的会话（被关掉了）：壳和草稿一起丢掉。
      // 本屏正在看的那个例外：画面留在原地（后端那头还认着它，接着往里发消息会自动把它重开），
      // 不硬生生把这边拽到别的会话去——别的窗口关掉它时会这样（自己点的那颗 × 不在此列）。
      Array.from(sessions.keys()).forEach((id) => {
        if (seen.has(id)) { return; }
        if (id === activeId && pendingCloseId !== id) { return; }
        if (pendingCloseId === id) { pendingCloseId = null; }
        removeSession(id);
      });
      // 当前会话是这块屏自己的事：别的屏切了会话（sessionList 里那个 activeId）不管，
      // 只有后端单发给本屏的 sessionActivated 才会切。这里只把画面重新挂好、状态刷一遍。
      // 后端说的“你看这个”比会话壳先到时先记着（见上面 sessionActivated 那段）：
      // 这批列表里有了就切过去；这批里也没有就当它已经过时（会话被关了之类），不再压着。
      if (pendingActivateId) {
        const pending = pendingActivateId;
        pendingActivateId = null;
        if (sessions.has(pending)) { activateSessionView(pending); }
        else if (activeId && sessions.has(activeId)) { mountActiveSession(); syncPaneStatuses(); }
      } else if (activeId && sessions.has(activeId)) {
        mountActiveSession();
        syncPaneStatuses();
      }
      renderSessionBar();
      updateSendState();
      syncStatus();
      refreshOpenSessionsInPicker();
      // 刚连上的这一批会话里可能已经有就绪的：把排队中的消息发出去
      flushPendingSend();
      return;
    }
    if (type === "sessionActivated") {
      const id = msg.sessionId;
      // 会话壳要先在（列表可能晚一步）：不在就先记着，等它出现在列表里再切
      if (id && sessions.has(id)) { pendingActivateId = null; activateSessionView(id); }
      else if (id) { pendingActivateId = id; }
      return;
    }
    if (type === "viewOptions") { applyViewOptions(msg); return; }
    if (type === "picker") { renderPicker(msg); return; }
    // 插件那头把浮层收了（超时、被新的浮层顶掉、页面被换下）：这边跟着收起来，别留一个点不动的空壳。
    if (type === "pickerCancel") { hidePicker(); return; }
    if (type === "historyPageAppend") {
      const st = pickerState;
      if (st && (st.kind === "history" || st.kind === "workspace")) {
        const more = (Array.isArray(msg.items) ? msg.items : []).map((it) => {
          if (st.kind !== "workspace") { return it; }
          // 面板里新来的一批是会话：补上分块标记（不然渲染不出会话样式）
          const copy = {};
          for (const k in it) { if (Object.prototype.hasOwnProperty.call(it, k)) { copy[k] = it[k]; } }
          copy.__section = "session";
          copy.section = HISTORY_SECTION;
          return copy;
        });
        if (st.kind === "workspace") {
          // 会话在上、工作区在下：新来的一批要插在工作区前面，不能接到末尾。
          let at = -1;
          for (let i = 0; i < st.items.length; i++) { if (st.items[i].__section === "space") { at = i; break; } }
          const insertAt = at < 0 ? st.items.length : at;
          Array.prototype.splice.apply(st.items, [insertAt, 0].concat(more));
        } else {
          st.items = st.items.concat(more);
        }
        st.historyHasMore = msg.hasMore === true;
        st.historyLoading = false;
        renderPickerItems();
      }
      return;
    }
    if (type === "historyPageEnd") {
      const st = pickerState;
      if (st && (st.kind === "history" || st.kind === "workspace")) {
        st.historyLoading = false;
        renderPickerItems();
      }
      return;
    }
    if (type === "workspacePageAppend") {
      // 工作区那块的下一批（点「加载更多」或一搜索就全取回来时走这里）；接在已有的工作区行后面。
      const st = pickerState;
      if (st && st.kind === "workspace") {
        const more = (Array.isArray(msg.items) ? msg.items : []).map((it) => {
          const copy = {};
          for (const k in it) { if (Object.prototype.hasOwnProperty.call(it, k)) { copy[k] = it[k]; } }
          copy.__section = "space";
          copy.section = "工作区";
          return copy;
        });
        st.items = st.items.concat(more);
        st.spacesHasMore = msg.hasMore === true;
        st.spacesLoading = false;
        renderPickerItems();
      }
      return;
    }
    if (type === "openSettings") { openSettings(); return; }
    if (type === "viewOptionItems") { viewOptionItems = Array.isArray(msg.items) ? msg.items : []; renderViewOpts(); return; }
    if (type === "focusInput") { setTimeout(function () { inputEl.focus(); }, 0); return; }
    // 宿主（VSCode 的命令入口，比如"发送选中文本"）替用户发一条：当作他打进输入框的，
    // 走同一条路（会话还没就绪就先留着、就绪了自动补发）
    if (type === "sendFromHost") { sendFromHost(msg.text); return; }
    // 宿主在某个会话跑完一轮时下发的消息（所有会话都会收到，带 sessionId）：按显示选项响一声，
    // 你没在看那个会话就把它标成“有新消息”。子会话不标：它跑完的结果会交回派它的会话，
    // 那边收到后会再跑一轮，到时候标那边就够了（子会话会挂在父会话下面，标了反而多一颗点）。
    if (type === "turnEnd") {
      // beep：后端说“这块屏正看着这个会话，该响”（别的屏跑完的不在这儿响，见后端那边）
      if (notifyOnTurnEnd && msg.beep !== false) { playTurnEndBeep(); }
      const done = msg.sessionId ? sessions.get(msg.sessionId) : null;
      if (done && done.id !== activeId && !(done.parentId && sessions.has(done.parentId))) {
        markSessionUnread(done);
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
      // 符号集合变化后，已渲染消息里的反引号可能需要变成可点击链接：就地补/去掉链接。
      // 注意不能整段重画 .md（会把运行时挂进去的工具标签抹掉，见 applySymbolLinks）；
      // 流式中的活跃消息交给 flush 管线，它下次重画时自然带上新符号集。
      for (const st of sessions.values()) {
        if (st.currentAssistant) { st.textDirty = true; scheduleFlush(st); }
        st.paneEl.querySelectorAll(".md").forEach((el) => {
          if (st.currentAssistant && el === st.currentAssistant.el) { return; }
          applySymbolLinks(el);
        });
      }
      return;
    }

    // 会话级消息
    applyPanelMessage(msg);
  });

  /**
   * 会话级消息（带 sessionId）：用户消息、流式增量、工具卡片、历史窗口等，逐条应用到对应窗格。
   * 抽成独立函数：网页端「加载更早」那批历史消息会包在 historyBatchEvent 里逐条送来，
   * 渲染进暂存区时也要走同一套分发（见 historyBatchEvent 那个 case）。
   */
  function applyPanelMessage(msg) {
    const type = msg.type;
    const sessionId = msg.sessionId;
    let t = null;
    if (sessionId) {
      t = sessions.get(sessionId) || createSession(sessionId, "新会话");
    } else {
      // 兜底：无 sessionId 的消息（后端尚未推送 sessionList）时用当前会话
      t = activeSession();
    }
    if (!t) { return; }
    // 安全网：界面刚起来、sessionList 还没到时，先把当前会话定下来。
    // 但后端已经说了“你看的是哪一个”（还在等它的会话壳）：不许拿“第一条冒出来的消息”顶上去，
    // 否则会暂时锚到别的会话，草稿也跟着认错主。
    // 注意别在这里碰输入框（草稿还没有主）；搬运与恢复交给 sessionList 那段做。
    if (!activeId && !pendingActivateId) {
      activeId = t.id;
      mountActiveSession();
      renderSessionBar();
      reflectSessionUI();
    }

    switch (type) {
      case "userMessage": {
        t.noCountPop = false;   // 自己这边开始的一轮：后面涨的次数是真新长出来的，+1 该飘
        finalizeCurrentAssistant(t);
        const label = msg.imageCount ? "[" + msg.imageCount + " 张图片] " : "";
        addPlain(t, "user", "你", label + (msg.text || ""));
        endThinking(t, "");
        scrollToBottom(t, true);
        break;
      }
      case "streamStart":
        t.noCountPop = false;   // 模型开始回了：这一轮里后面长出来的次数都是新的
        t.activity = msg.activity || "working";
        t.activityDetail = msg.detail || "";
        setStreaming(t, true);
        finalizeCurrentAssistant(t);
        endThinking(t, "");
        // 新一轮生成：速度计时重新开始，上一轮均值先清零（有数据后由实时值接管）
        t.tps = undefined;
        t.tpsStart = Date.now();
        t.tpsTokens = 0;
        break;
      case "streamEnd":
        if (t.rafId) { flushDeltas(t); }
        finalizeCurrentAssistant(t);
        endThinking(t, "");   // 想一半被中止（或后端没发收尾）：标签也得停住
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
        // 提示音与新消息标记改由扩展宿主在“一轮真正结束”时下发 turnEnd 消息
        // （见 notifyOnTurnEnd），这里不再对当前会话单独出声：后台的会话跑完也能听见。
        break;
      case "activityChanged":
        setActivity(t, msg.activity, msg.detail);
        // 离开「思考中」就说明这一段想完了：个别 provider 不发 thinking_end 时在这里兜底收尾
        if (msg.activity !== "thinking") { endThinking(t, ""); }
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
      case "thinkingStart":
        startThinking(t);
        break;
      case "thinkingDelta": {
        // 兼容较旧后端：即使没有先收到 thinkingStart，也按正在思考渲染。
        if (t.activity !== "thinking") { t.activity = "thinking"; }
        const thinking = startThinking(t);
        thinking.resultText += msg.delta;
        refreshTagTipIfShowing(thinking.group.tag);   // 提示框开着时跟着长大
        t.tpsTokens += estTokens(msg.delta);
        if (activeId === t.id) { syncStatus(); }
        break;
      }
      case "thinkingFull":
        // 想完一段：整段文本随 pi 的 thinking_end 过来（历史重放也只来这一条），见 endThinking。
        // 正在往暂存区补更早的历史（t._stage）时另开一条，别动手头正在想的那一条。
        endThinking(t, msg.text, !!t._stage);
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
        // 重画历史（切会话 / 重连）随之开始：这之后涌进来的工具调用都是老消息，别飘 +1
        t.noCountPop = true;
        t.paneEl.innerHTML = '<div class="empty-hint">输入消息开始对话…</div>';
        t.emptyHintGone = false;   // 空提示又回来了（见 hideEmptyHint）
        // 历史窗口状态一并重置：按钮随 innerHTML 清掉了；暂存区里若有没插完的
        // 「加载更早」那批也作废（会话已换，再插进去就串了），置个丢弃标记等 End 来清
        t._historyBtn = null;
        t.hasMoreHistory = false;
        if (t._stage) { t._stage = null; t._stageDropped = true; }
        // 后端可能在 loading 状态中再次 clear（例如切换完成后重绘消息），
        // 不能因此把进行中的加载反馈一并清掉。
        syncSessionLoading(t);
        t.currentAssistant = null;
        t.thinkingEntry = null;
        t.currentToolRow = null;
        t.toolGroups = null;
        t.toolGroupEntries.clear();
        t.pendingToolCards.clear();
        for (const tg of t.pendingToolTags.values()) { clearInterval(tg._timer); }
        t.pendingToolTags.clear();
        // 重置当前会话的输入草稿（该会话就是当前那个，同步到输入框）。
        // 整屏重画（页面刷新 / 重连后补内容）也走 clear：那种 clear 带 keepDraft，
        // 不能把人打了一半的字和附件抹掉，也不要把键盘拉起来。
        if (!msg.keepDraft && activeId === t.id) {
          const d = draftOfSession();
          d.text = "";
          d.images = [];
          d.textBlocks = [];
          inputEl.value = "";
          autoResize();   // 同上：清空后按空内容重算高度，别写死下限那个值
          renderAttachmentsFor();
          inputEl.focus();
        }
        break;
      case "toolResultUpdate": {
        // 缓存部分结果，悬浮提示随取随画
        const groupEntry = t.toolGroupEntries.get(msg.toolCallId);
        if (groupEntry) {
          groupEntry.resultText = msg.resultText || "";
          groupEntry.meta = { isPartial: true, durationMs: msg.durationMs };
          refreshTagTipIfShowing(groupEntry.group.tag);
          break;
        }
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl._resultText = msg.resultText || "";
          tagEl._resultMeta = { isPartial: true, durationMs: msg.durationMs };
          setTagTip(tagEl, tagEl._resultText, "");
        }
        break;
      }
      case "toolResult": {
        const groupEntry = t.toolGroupEntries.get(msg.toolCallId);
        if (groupEntry) {
          // 合并组里的那一条：结果填回组里（提示框里那条的结果），标签上的条数/转圈/标红跟着重算
          if (Array.isArray(msg.images) && msg.images.length > 0) {
            removeEntryFromGroup(t, groupEntry, msg.images);
          } else {
            groupEntry.done = true;
            groupEntry.isError = !!msg.isError;
            groupEntry.resultText = msg.resultText || "";
            groupEntry.meta = { isError: !!msg.isError, durationMs: msg.durationMs, truncation: msg.truncation || null };
            t.toolGroupEntries.delete(msg.toolCallId);
            syncGroupTag(groupEntry.group);
            scrollToBottom(t);
          }
          break;
        }
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl.classList.remove("running");
          if (msg.isError) { tagEl.classList.add("error"); }
          // 记录结果：文字结果供悬浮提示用（见 setTagTip），带图的走另一条路
          tagEl._done = true;
          tagEl._isError = !!msg.isError;
          tagEl._resultText = msg.resultText || "";
          tagEl._resultMeta = { isError: !!msg.isError, durationMs: msg.durationMs, truncation: msg.truncation || null, images: msg.images || null };
          t.pendingToolTags.delete(msg.toolCallId);
          // read 读图：小标签收掉，换成对话里的一整块图（不再走悬浮提示）
          if (Array.isArray(msg.images) && msg.images.length > 0) {
            dropToolTag(t, tagEl);
            mountToolImageBlock(t, { toolName: tagEl._toolName, argStr: tagEl._argStr, tipCall: tagEl._tipCall }, msg.images);
          } else {
            setTagTip(tagEl, tagEl._resultText, "");
          }
        }
        break;
      }
      case "modelChanged":
        t.modelId = msg.modelId || "";
        t.provider = msg.provider || "";
        if (activeId === t.id) { syncStatus(); }
        syncPaneStatuses();
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
        syncPaneStatuses();
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
        t.noCountPop = true;   // 补齐更早的历史，同样别飘 +1
        if (t._stageDropped) { break; }
        const inner = msg.event && typeof msg.event === "object" ? msg.event : null;
        if (!inner) { break; }
        if (!t._stage) { t._stage = document.createElement("div"); }
        inner.sessionId = msg.sessionId;
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
        vscode.postMessage({ type: "loadOlderHistory", sessionId: t.id });
      });
      t._historyBtn = btn;
      // 「加载更早」按钮永远留在窗格最顶上，往后渲染的消息都排在它后面。
      pane.insertBefore(btn, pane.firstChild);
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
      anchor = pane.firstChild;
    }
    const beforeHeight = pane.scrollHeight;
    // 这一下由我们自己补滚动位置：先把浏览器的滚动锚定临时关掉，
    // 它也会因为“上方变高”补一次，两边叠起来视野就被推下去一整批的高度。
    // 关掉再插、读完高度就还回去，别的地方（图片后到、高亮重排）还是交给它锚。
    const prevAnchorStyle = pane.style.overflowAnchor;
    pane.style.overflowAnchor = "none";
    while (stage.firstChild) { pane.insertBefore(stage.firstChild, anchor); }
    const grew = pane.scrollHeight - beforeHeight;
    pane.style.overflowAnchor = prevAnchorStyle;
    if (pane.isConnected) {
      // 上方变高了：滚动位置同步下移，让视野还停在原来那几条消息上
      pane.scrollTop += grew;
    }
  }

  function removeSession(id) {
    const st = sessions.get(id);
    if (!st) { return; }
    cancelFlush(st);
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); }
    for (const tg of st.pendingToolTags.values()) { clearInterval(tg._timer); }
    st.viewEl.remove();
    sessions.delete(id);
    sessionDrafts.delete(id);
    if (activeId === id) { activeId = null; syncJumpBottom(st); syncComposerButtons(); }
  }

  // ==================== 设置浮层（插件选项）====================
  // 模型（models.json）从这里撤了：那是 pi 自己的配置，插件不再读写它，界面上也不再出现。
  const settingsOverlay = document.getElementById("settingsOverlay");
  let viewOptionItems = [];
  const viewOptsRoot = document.getElementById("viewOptsRoot");

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

  function openSettings() {
    // 每次打开都重问一遍选项的当前值：真正存着的是后端那份插件设置，
    // 别的窗口 / 别的设备改过之后，这边不能拿着旧值显示。
    vscode.postMessage({ type: "requestViewOptionItems" });
    renderViewOpts();
    settingsOverlay.classList.remove("hidden");
  }
  function closeSettings() {
    settingsOverlay.classList.add("hidden");
  }
  settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) { closeSettings(); } });
  const settingsCloseBtn = document.getElementById("settingsClose");
  if (settingsCloseBtn) { settingsCloseBtn.addEventListener("click", closeSettings); }

  vscode.postMessage({ type: "ready" });
})();
