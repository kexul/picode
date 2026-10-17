// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  // 是否运行在网页服务的页面里（browserBridge.js 会先于本文件在 window 上放好这个标记）。
  // 网页端与 VSCode 共用这份脚本，少数行为按此区分：write / edit 那颗粒上点「跳转」往哪儿开、
  // 左边的文件侧边栏只在浏览器页面里长出来（插件里的对话面板里点链接交给编辑器打开）。
  const IN_WEBVIEW = window.pichatInWebview === true;
  // 供扩展宿主选择“最后活动的 Pi Chat”；pointerdown 覆盖大多数 webview
  // 内部交互，focus 覆盖 Ctrl+Tab / 编辑器组切换后的焦点恢复。
  const notifyHostFocus = () => vscode.postMessage({ type: "hostFocus" });
  window.addEventListener("focus", notifyHostFocus);
  document.addEventListener("pointerdown", notifyHostFocus, { capture: true });
  // 用户第一次碰界面（有手势）时顺便问一次通知权限：浏览器喜欢在用户有动作的时候问；
  // 没问过才问，问过就不扰人（见 askNotifyPermission）。
  document.addEventListener("pointerdown", function askNotifyOnce() { askNotifyPermission(); }, { capture: true, once: true });
  const messagesEl = document.getElementById("messages"); // 容器，内含各 .session-pane
  const jumpBottomBtn = document.getElementById("jumpBottom");
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
    // 粗一点的勾：跟上面那颗叉同款同大小（会话行尾的确认用，一颗勾一颗叉并排）。
    "check-bold": '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2.6 8.6 L6.4 12.4 L13.4 3.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
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
    // 折行开关（文件侧边栏角上）：上面一条整线、下面一条短线，中间那条走到头再拐回来
    //（「长行折回来」那个意思）。
    wrap: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h12M2 7h9.4a2.5 2.5 0 0 1 0 5H8"/><path d="M10.2 9.6 7.6 12l2.6 2.4"/><path d="M2 12h2.4"/></svg>',
    // 往右的箭头：消息流末尾那条「继续」上用（VSCode 官方 codicon 的 arrow-right）
    "arrow-right": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8.85355 3.14645C8.65829 2.95118 8.34171 2.95118 8.14645 3.14645C7.95118 3.34171 7.95118 3.65829 8.14645 3.85355L11.7929 7.5H2.5C2.22386 7.5 2 7.72386 2 8C2 8.27614 2.22386 8.5 2.5 8.5H11.7929L8.14645 12.1464C7.95118 12.3417 7.95118 12.6583 8.14645 12.8536C8.34171 13.0488 8.65829 13.0488 8.85355 12.8536L13.3536 8.35355C13.5488 8.15829 13.5488 7.84171 13.3536 7.64645L8.85355 3.14645Z"/></svg>',
    // 实心方块：消息流末尾那两颗「卡住了」「停止生成」上都用它
    "stop-square": '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1.5"/></svg>',
    // 三条横线：输入框左边那颗「你说过的话」（一句话一行，所以是清单）。
    said: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7"/></svg>',
  };
  /** 文件夹选择器里行首那颗图标：名字由宿主给（见 chatHost.ts 里 showFolderPicker 的 items）。 */
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
  // 两行右边那颗朝下的小箭头：只在开着两个以上会话时露面（提示这里点得开、能换）。
  // 挂在装着两行的这颗按钮上（它是按钮里最后一个孩子，所以落在右边）：
  // 竖直方向跟着两行一起居中，不单对着会话名那一行（见 chat.css 的 #sessionName）。
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

  // ---- 面板：浮层里的拾取器（模型 / 历史 / 项目与会话 / 文件夹）与常驻那一列 ----
  // 这两处共用同一套画法（版式也共用一套类名，见 chat.css），只是画到不同的容器上：
  // 一个 view 就是“画到哪儿”那一摊（那几个 DOM 元素 + 这份面板自己的状态）。
  // 状态按 view 分开挂，所以两块面板可以同时各画各的一份、互不打扰：
  //   { kind, items, filtered, sel, current, draftModel, draftThinking, toggle, … }
  // 画出来以后还留几样（都是「重画时只动变了的那一块」要用的，见 refreshOpenSessionsIn）：
  //   sessionPane / spacePane 是「项目与会话」上下两格（其余面板没有，是 null，就画在面板身上）；
  //   openSessionsShown / spaceRowsShown 是这两格当前长什么样的指纹（见 paintWorkspacePanel）。
  const modalView = {
    root: document.getElementById("pickerOverlay"),
    header: document.getElementById("pickerHeader"),
    title: document.getElementById("pickerTitle"),
    subtitle: document.getElementById("pickerSubtitle"),
    search: document.getElementById("pickerSearch"),
    searchWrap: document.getElementById("pickerSearchWrap"),
    body: document.getElementById("pickerBody"),
    footer: document.getElementById("pickerFooter"),
    state: null,
    openSessionsShown: "",
    keepOpen: false,        // 点一行是“选完就走”（浮层）
    staticChrome: false,    // 头几颗类（pk-drawer / pk-workspace）是渲染时加上去的，收起时摘掉
  };
  /** 宽窗下常驻那一列（「项目与会话」）：自己的容器，不跟浮层抢地方（见下面“常驻的项目与会话侧边栏”）。 */
  const dockView = {
    root: document.getElementById("sidebarDock"),
    header: document.getElementById("dockHeader"),
    title: document.getElementById("dockTitle"),
    subtitle: null,
    search: null,
    searchWrap: null,
    body: document.getElementById("dockBody"),
    footer: document.getElementById("dockFooter"),
    state: null,
    openSessionsShown: "",
    keepOpen: true,         // 点一行只是“用一下”，面板留着接着点
    staticChrome: true,     // 那几颗类写在 HTML 里，收起也不摘
  };
  /**
   * 标题下面那行小字（目前只有文件夹选择器用：正在看的是哪个目录）。
   * 骨架里没这个元素时（插件与后端的版本对不上：界面文件是现从后端取的）就当没有，不能让浮层打不开。
   */
  function setPickerSubtitle(text, view = modalView) {
    if (!view.subtitle) { return; }
    view.subtitle.textContent = text || "";
    view.subtitle.classList.toggle("hidden", !text);
  }

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
    "bin",
    "tar","gz","zip","7z","rar","bz2","xz",
    "gradle","sbt","rake","gemspec",
    "csproj","vbproj","fsproj","vcxproj","sln","props","targets",
    "dockerfile","containerfile","makefile","cmake","ninja",
  ]);
  const FILE_RE = /^((?:[\w@-]+\/)*[\w@-]+(?:\.[A-Za-z][\w-]*)+)(?::(\d+))?(?::(\d+))?$/;
  // 目录链接只认「以斜杠结尾」这一种写法（`dev/`、`src/utils/`）：末尾斜杠后面不能再跟词里的
  // 字符，所以英文里的 and/or 不会把 `and/` 认成路径；不带斜杠又不带扩展名的写法不认（先这样）。
  const DIR_RE = /^(?:[\w@-]+\/)+(?![\w@-])/;
  /** 整段就是一条目录路径（行内代码里那种写法）。 */
  function isDirPath(text) { const m = DIR_RE.exec(text); return !!m && m[0] === text; }
  function lastExt(p) { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i + 1).toLowerCase(); }
  function isFilePathlike(path) { return KNOWN_EXT.has(lastExt(path)); }
  function escHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  // LSP 符号集合（provider 推送）：命中的反引号文本渲染成可点击符号链接。
  let symbolNames = new Set();
  function symbolLinkHTML(name, inner) {
    return `<a class="symbol-link" href="#" data-symbol="${escHtml(name)}">${inner != null ? inner : escHtml(name)}</a>`;
  }
  function fileLinkHTML(path, line, col, inner, dir) {
    // 插件里的对话面板里不给目录链接：那边点链接是交给编辑器打开一个文件（编辑器打不开目录），
    // 以前 `dev/` 就是普通文字，那边照旧（这一列也只长在浏览器页面里）。
    if (dir && IN_WEBVIEW) { return inner != null ? inner : escHtml(path); }
    const da = escHtml(path);
    const tail = line ? ":" + line + (col ? ":" + col : "") : "";
    const dl = line ? ` data-line="${line}"` : "";
    const dc = col ? ` data-col="${col}"` : "";
    const dd = dir ? ' data-dir="1"' : "";
    return `<a class="file-link" href="#" data-file="${da}"${dd}${dl}${dc}>${inner != null ? inner : escHtml(path) + tail}</a>`;
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
          if (m && isFilePathlike(m[1])) {
            return { type: "filelink", raw: m[0], path: m[1], line: m[2] ? parseInt(m[2], 10) : null, col: m[3] ? parseInt(m[3], 10) : null };
          }
          const d = DIR_RE.exec(src);
          if (d) { return { type: "filelink", raw: d[0], path: d[0], line: null, col: null, dir: true }; }
          return;
        },
        renderer(t) { return fileLinkHTML(t.path, t.line, t.col, null, t.dir); },
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
          if (isDirPath(text)) {
            return `<code>${fileLinkHTML(text, null, null, escHtml(text), true)}</code>`;
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
  function renderMarkdown(source) { ensureMarkedHighlight(); ensureFileLink(); return marked.parse(source, mdOptions()); }

  /**
   * 按当前符号集合，把已渲染正文里的行内代码就地变成可点击的符号链接（或还原回普通文字）。
   *
   * 为什么在这里整段重画（el.innerHTML = renderMarkdown(el.dataset.raw)）不行：符号链接就是
   * 运行时挂进 .md 里的 DOM（下面这段干的），重画只认 markdown 原文，会把它们一起抹掉。
   *（工具标签（write / edit 那几种也在内）早就不在 .md 里了：它们各自独立成一行，见 toolTagHost。）
   * 只改行内 code 节点，别的东西一律不动。
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
  var notifyTurnEnd = true;
  let openFiles = [];
  function applyFontSize(px) {
    var val = (typeof px === "string" && /^\d+$/.test(px)) ? px + "px" : "";
    [document.documentElement, document.body].forEach(function (el) { el.style[val ? "setProperty" : "removeProperty"]("--vscode-font-size", val); });
    // 字号一变，同一行字占的高度也跟着变：输入框的高度得按新字号重算，
    // 否则框还是旧字号时量出来的那么高，右边就冒出一根滚动条（见 autoResize）。
    autoResize();
    // 顶条（会话名 + 目录两行）也会跟着长高变矮：常驻那一列的面板头得重新跟它对齐
    syncDockHeaderHeight();
  }
  function applyViewOptions(opts) {
    if (typeof opts.fontSize === "string") { applyFontSize(opts.fontSize); }
    if (typeof opts.sendKey === "string") { sendKeyCombo = opts.sendKey; }
    if (typeof opts.newSessionKey === "string") { newSessionKey = opts.newSessionKey; }
    if (typeof opts.tabSwitchKey === "string") { tabSwitchKey = opts.tabSwitchKey; }
    notifyTurnEnd = opts.notifyTurnEnd !== false;
  }

  // ── 跑完一轮 / 模型提问时的系统通知（浏览器通知，不再出提示音） ──
  // 要人回来看一眼的事都发一条：任何会话（包括别的屏在聊的、后台的）跑完一轮，
  // 以及模型在某个会话里问了一道选择题（ask_choice，正等着人答）。
  // 被中止的那一轮不算跑完，不发。别人派的子会话跑完不发：它的结果会交回派它的那个会话，
  // 那边跑完再发（后端在消息里标了 child）。每台设备能不能发，看它自己的浏览器给不给通知权限：
  // 手机用局域网地址打开（不是 https、也不是本机地址）时浏览器根本不给。发不出来就当没有通知。
  function canNotify() {
    // 插件里的对话面板（VSCode 的网页视图）不发：那边是沙箱里的一块网页，浏览器不给通知权限，
    // 也不该在插件界面里弹那个“允许通知”的框。
    // 地址不是安全来源时也不发：浏览器认 https 与本机地址，http://192.168.x.x 这种直接不给权限，
    // 而且它连“拒绝”都不说（干脆不问）。判断放在这里，下面解释原因的那段才说得对路。
    try { return !IN_WEBVIEW && window.isSecureContext !== false && typeof Notification !== "undefined" && !!Notification; } catch (e) { return false; }
  }

  /** 问一次通知权限（没问过才问；浏览器不给的就没办法了）。用户点界面时调，有手势更容易给。 */
  function askNotifyPermission() {
    try {
      if (!canNotify() || Notification.permission !== "default") { return; }
      var asked = Notification.requestPermission();
      if (asked && typeof asked.catch === "function") { asked.catch(function () { /* 不问就算了 */ }); }
    } catch (e) { /* 不支持通知的环境就算了 */ }
  }

  /** 这台设备现在能不能发通知，不能的话人话说明为什么（写给设置里那一项看）。 */
  function notifyUnavailableNote() {
    try {
      if (IN_WEBVIEW) { return "插件里的对话面板里发不了系统通知（那边看「有新消息」那颗点），浏览器页面里才有" };
      if (!canNotify()) { return "这台设备上用不了：浏览器只在 https 或本机地址下给通知权限（http 地址就是这样）"; }
      if (Notification.permission === "denied") { return "这台设备的浏览器把它拦了（在地址栏那个图标里可以放开）"; }
      if (Notification.permission !== "granted") { return "这台设备还没允许通知：点这一项会问一次"; }
      return "";
    } catch (e) { return ""; }
  }

  /** 弹一条“某个会话那边有事”的系统通知：标题是会话名，点一下把页面拉到前台并切到那个会话。
   *  tag 按事由分开（跑完一轮 / 模型提问各一套）：同一个会话的同类旧通知原地换成新的，不堆一屏。 */
  function showSessionNotice(sessionId, body, fallback, tag) {
    try {
      if (!canNotify() || Notification.permission !== "granted") { return; }
      const st = sessions.get(sessionId);
      const title = st ? sessionLabel(st) : "Pi Chat";
      const note = new Notification(title, {
        body: (body || "").trim() || fallback,
        tag: tag,
      });
      note.onclick = function () {
        window.focus();
        if (sessions.has(sessionId)) { activateSessionView(sessionId); }
        // 切会话是每块屏各管各的：本屏得自己跟后端说一声
        vscode.postMessage({ type: "switchSession", sessionId: sessionId });
      };
    } catch (e) { /* 通知发不出去就算了，蓝点还在 */ }
  }

  /** 一个会话跑完一轮。 */
  function notifyTurnEndFor(sessionId, status, text) {
    if (!notifyTurnEnd || status === "cancelled") { return; }
    showSessionNotice(sessionId, text, "跑完了一轮", "pichat-turn-end-" + sessionId);
  }

  /** 模型在某个会话里问了一道选择题（ask_choice），正等着人答：跟“跑完一轮”一样提醒一声。
   *  卡片只发给正看着那个会话的屏（见后端 askOnScreens），这条谁都收得到 —— 人在别的会话 /
   *  别的窗口里时也能知道该去答一句。用的是同一个开关（设置里的“跑完发系统通知”）。 */
  function notifyAskFor(sessionId, text) {
    if (!notifyTurnEnd) { return; }
    showSessionNotice(sessionId, text, "问你一道选择题", "pichat-ask-" + sessionId);
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
      if (st.programmaticScroll) {
        st.programmaticScroll = false;
        // 只吞「位置确实是自己刚设的那个」那一次。不能看见标记就吞：追底动画中间
        // 用户往回滚一下（或者调试脚本把视野挪到别处），那一下就被当成“程序滚动”丢掉，
        // 界面继续把人拉回底部（见 dev/historyScroll.js）。
        const mine = st.programmaticTop === Infinity
          ? pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1
          : Math.abs(pane.scrollTop - st.programmaticTop) <= 1;
        if (mine) { return; }
      }
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
      // 本段消息（上一条用户气泡之后的这一段回复）里那颗 think 标签：末尾补来的思考并到它身上，
      // 见 noteThinkingEntry / foldTailThinking。来了用户消息 / 整屏重画就归零。
      segmentThinking: null,
      // 末尾候选：本段已有 think 之后又冒出来的一颗（可能是「末尾补来的一段思考」，也可能后面
      // 还有正文 / 工具）；跑完一轮它还留在末尾就并回上面那颗，见 foldTailThinking。
      tailThinking: null,
      // 生成速度统计：本轮累计估算 token 数 / 起点时间；tps 为上一轮最终均值
      tps: undefined,
      tpsStart: 0,
      tpsTokens: 0,
      currentToolRow: null,
      // 消息流末尾那条「正在跑」的：贴在当前这批工具标签下面，一行一条（见 syncRunningLine）
      runningLine: null,
      // 这一批（一条工具调用行）里按工具名归拢的合并标签（见 addToolToGroup）：
      // { row, byName }，byName 记 工具名 → 组里那一条；行一换（来了正文）就是新的一批。
      // toolGroupEntries 记 callId → 组里那一条，结果回来时按它找到该更新哪一条。
      toolGroups: null,
      toolGroupEntries: new Map(),
      pendingToolCards: new Map(),
      pendingToolTags: new Map(),
      // 这个会话消息流里的问话卡片：卡片编号 → { el, kind, multi, picked, done }（见 renderAskCard）
      askCards: new Map(),
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
      programmaticTop: 0,        // 上一次程序自己设的滚动位置（判断那一帧的 scroll 事件是不是自己弄的，见上面那段）
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
      st.programmaticTop = p.scrollHeight;
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
   * 这个会话派出去的子会话里，有几个还在跑：子会话自己在跑（正在答、或者刚开始
   * 那一轮），或者刚派出去、任务还没发完（taba 那边是 starting）。
   * 顶条中间那颗名字上的小点（以及它下面那个数字）用它：本会话自己闲着、
   * 子会话还在干活时照样亮着呼吸，数字写清有几个。
   */
  function runningChildCount(id) {
    let n = 0;
    for (const s of sessions.values()) {
      if (s.parentId !== id) { continue; }
      if (s.streaming || s.loading) { n++; continue; }
      const state = s.taba ? s.taba.state : "";
      if (state === "starting" || state === "running") { n++; }
    }
    return n;
  }

  /** 顶条中间那行字：当前会话名（带在跑的小点；主会话多过一个就再挂一颗朝下的小箭头）。 */
  function renderSessionBar() {
    const st = activeId ? sessions.get(activeId) : null;
    const text = sessionLabel(st);
    const textEl = sessionNameBtn.querySelector(".sn-text");
    if (textEl) { textEl.textContent = text; }
    // 派出去的子会话还有几个在跑：写在小点下面（零个就空着，那一格自己收起来）。
    const kids = st ? runningChildCount(st.id) : 0;
    const countEl = sessionNameBtn.querySelector(".sn-count");
    if (countEl) { countEl.textContent = kids > 0 ? String(kids) : ""; }
    sessionNameBtn.title = "当前会话：" + text + (kids > 0 ? "，" + kids + " 个子会话在跑" : "") + "（点这里换会话）";
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
    sessionNameBtn.classList.toggle("child-running", kids > 0);
    // 别的会话跑完了你没看（“有新消息”）：名字左边那颗小点亮着，不闪；切过去看就灭。
    // 当前这个会话正在跑时那颗点拿去闪了（streaming 优先），未读还得点开清单看。
    sessionNameBtn.classList.toggle("unread", Array.from(sessions.values()).some((s) => s.unread));
    // 就一个主会话时不必提示“这里能换”（点开还是同一张清单：里面就它自己）
    sessionCaret.classList.toggle("hidden", sessionMenuItems().length < 2);
    // 清单开着的时候它会跟着变（换会话、改标题、某个会话跑完了）：重画完还要重新摆——
    // 内容变宽变窄了，贴着屏幕边的位置就不对了。
    refreshSessionMenu();
    // 顶条自己也会长高变矮（目录那行有 / 没有）：两边常驻那一列的面板头跟着它齐（见 syncDockHeaderHeight）
    syncDockHeaderHeight();
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
  // 某一行转成确认条（行尾多一颗勾）以后要钉住的宽度：点叉的那一下量下来。
  let sessionMenuPin = 0;

  /** 把清单贴在中间那一列底下（名字与目录两行都在它上面，清单别盖住目录行）：
   *  先量准宽度，再把整块夹进屏幕里（左右各留 8px）。
   *  有人正在确认关会话时宽度钉在点叉之前的那个值上：行尾多一颗勾也不许把整张清单撑宽。 */
  function placeSessionMenu() {
    const anchor = (sessionCenterEl || sessionNameBtn).getBoundingClientRect();
    const margin = 8;
    // 量之前先把上一次留下的 left / width 清掉：left 留着会挤小可用宽度、
    // 上一次钉死的 width 会掩盖内容的自然宽度，两种都会把宽度量成错的。
    sessionMenuEl.style.left = "0px";
    sessionMenuEl.style.width = "";
    const room = Math.max(140, window.innerWidth - margin * 2);
    const natural = sessionMenuEl.offsetWidth;
    // 确认条收回去（或关了会话）就放开：宽度又跟着内容自己走
    if (!pendingCloseId) { sessionMenuPin = 0; }
    const width = Math.min(sessionMenuPin || natural, room);
    // 只有需要钉住的时候才写死宽度：确认条那阵、或者整块比一屏还宽
    // （CSS 的 max-width 是以内容盒算的，这里按整块算）。其余时候让它自己跟着内容走。
    if (sessionMenuPin || natural > room) { sessionMenuEl.style.width = width + "px"; }
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

  /** 画一遍清单内容：开着的主会话一行一个（行尾一颗关闭叉，点了先变确认条：行尾多一颗勾，再点勾才真关）。 */
  function renderSessionMenu() {
    sessionMenuEl.innerHTML = "";
    sessionMenuItems().forEach((item) => {
      const el = document.createElement("div");
      el.className = "sm-item" + (item.current ? " current" : "");
      el.title = (item.label || "") + (item.cwd ? "\n" + item.cwd : "");
      // 行首那颗小点、下面「名字 + 目录」两段：普通行与确认条共用这一份
      // （确认条只是行尾那颗叉旁边多一颗勾，行里的东西一点不动：关的是哪一个照样看得见，
      //  整张清单的宽窄也不跟着变——宽度在点叉那一下已经钉住，见 placeSessionMenu）。
      const dot = document.createElement("span");
      dot.className = "sm-dot" + openDotClass(item);
      el.appendChild(dot);
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
      if (item.pendingClose) {
        // 点过行尾那颗叉：整行底色变红，行尾多一颗勾——点勾才真关，点叉撤销。
        el.classList.add("sm-confirm");
        const yes = document.createElement("button");
        yes.type = "button"; yes.className = "sm-yes";
        yes.title = "关闭这个会话";
        yes.setAttribute("aria-label", "关闭这个会话");
        yes.innerHTML = ICONS["check-bold"];
        yes.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(item.sessionId); });
        const no = document.createElement("button");
        no.type = "button"; no.className = "sm-no";
        no.title = "取消";
        no.setAttribute("aria-label", "取消");
        no.innerHTML = ICONS["close-bold"];
        no.addEventListener("click", (e) => {
          e.stopPropagation();
          cancelPendingClose();
          refreshSessionMenu();
        });
        el.appendChild(yes); el.appendChild(no);
      } else {
        // 行尾不再挂「当前」/「在跑」：当前那条整行有底色，在跑 / 有新消息看名字前头那颗小点。
        // 行尾这颗叉：点行是切过去（大目标），点叉才关（还要再确认一下）。
        const close = document.createElement("span");
        close.className = "sm-close";
        close.title = "关闭这个会话";
        close.setAttribute("aria-label", "关闭这个会话");
        close.innerHTML = ICONS["close-bold"];
        close.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(item.sessionId); });
        el.appendChild(close);
        el.addEventListener("click", () => {
          closeSessionMenu();
          if (!item.current) { vscode.postMessage({ type: "switchSession", sessionId: item.sessionId }); }
        });
      }
      sessionMenuEl.appendChild(el);
    });
  }

  /** 清单开着就重画一遍（关会话的确认条变来变去）；重画完还得重新摆位（宽窄变了：确认条那阵宽度是钉住的）。 */
  function refreshSessionMenu() {
    if (!sessionMenuOpen) { return; }
    // 行都关没了就先收起这张空壳（全关完时后端会补一个空会话，等新列表到了再说）
    if (!sessionMenuItems().length) { closeSessionMenu(); return; }
    renderSessionMenu();
    placeSessionMenu();
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
    sessionMenuPin = 0;
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
    if (Math.abs(diff) < 1) { st.programmaticScroll = true; st.programmaticTop = target; st.paneEl.scrollTop = target; st.lerpRafId = 0; return; }
    st.programmaticScroll = true;
    st.programmaticTop = cur + diff * 0.3;
    st.paneEl.scrollTop = st.programmaticTop;
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
    // 末尾那颗胶囊（「继续」/「卡住了」）永远跟在最新内容后面：新内容上来先把它挪回末尾
    // （它自己不算“新内容”，也不改滚动位置，见 placeEndHint）
    placeEndHint(st);
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
      st.programmaticTop = Infinity;   // 滚到底：具体落到哪个数由浏览器夹住，这里不去读 scrollHeight
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

  /**
   * 跳到某一条用户消息（「你说过的话」清单里的一行）：滚到窗格顶上、闪一下底色，
   * 并且接管滚动（别让追底把人拽回去）。
   */
  function jumpToUserMessage(st, el) {
    if (!el || !el.isConnected) { return; }
    userTookOverScroll(st);   // 跟用户自己往回滚一样：停掉追底；正在生成时把「跳到最新」亮起来
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); st.lerpRafId = 0; }
    if (st.scrollRafId) { cancelAnimationFrame(st.scrollRafId); st.scrollRafId = 0; }
    st.paneEl.scrollTop = Math.max(0, el.offsetTop - 6);
    flashMessage(el);
  }

  /** 跳过去的那一条闪一下底色（连着点同一行也再闪一次）。 */
  function flashMessage(el) {
    el.classList.remove("msg-flash");
    void el.offsetWidth;   // 逼一次重排：去掉再加同一个类，动画不会重放
    el.classList.add("msg-flash");
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => el.classList.remove("msg-flash"), 1400);
  }

  /** 那条消息的开头一行（清单里那一行写的字）。 */
  const SAID_PREVIEW_CHARS = 60;
  function messagePreviewText(el) {
    const raw = el.dataset.raw || el.textContent || "";
    const one = raw.replace(/\s+/g, " ").trim();
    if (!one) { return "（空消息）"; }
    return one.length > SAID_PREVIEW_CHARS ? one.slice(0, SAID_PREVIEW_CHARS) + "…" : one;
  }

  // ==================== 你说过的话（输入框左边那颗按钮）====================
  // 那颗按钮一直露着（空会话里也点得开，点开说一句“你还没说过话”）。
  // 清单从输入行上头往上弹一张小的（输入框就在屏幕底，往下弹会顶到键盘、出屏幕），
  // 一行一句，点一行就跳到那条（去的地方跟导航条一样，见 jumpToUserMessage）。
  // 手机上尤其要它：手指点一行比点一个几点准得多。
  let saidBtn = null;
  let saidMenu = null;
  (function buildSaidButton() {
    const row = document.getElementById("inputRow");
    const input = document.getElementById("input");
    if (!row || !input) { return; }
    saidBtn = document.createElement("button");
    saidBtn.type = "button";
    saidBtn.id = "saidBtn";
    saidBtn.innerHTML = ICONS.said;
    saidBtn.title = "你说过的话";
    saidBtn.setAttribute("aria-label", "你说过的话");
    row.insertBefore(saidBtn, input);
    // 清单挂在输入行里：靠这一行定位（bottom: 100% 就是“输入行的上头”）
    saidMenu = document.createElement("div");
    saidMenu.id = "saidMenu";
    saidMenu.className = "hidden";
    row.appendChild(saidMenu);
    saidBtn.addEventListener("click", (e) => {
      e.stopPropagation();   // 别让下面那个“点外头收起”的监听当场又把它关掉
      toggleSaidMenu();
    });
    document.addEventListener("click", (e) => {
      if (!saidOpen()) { return; }
      if (saidMenu.contains(e.target) || saidBtn.contains(e.target)) { return; }
      closeSaidMenu();
    });
    // Esc 收起。这条监听得比输入框那条先跑（stopImmediatePropagation）：
    // 不然输入框那边会把 Esc 当成“中止这一轮”。
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !saidOpen()) { return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSaidMenu();
    });
  })();

  function saidOpen() { return !!saidMenu && !saidMenu.classList.contains("hidden"); }

  /** 把清单铺满：一行一句，序号 + 开头；正读着的那一句标亮。 */
  function renderSaidList(st) {
    saidMenu.innerHTML = "";
    const msgs = st && st.paneEl ? Array.prototype.slice.call(st.paneEl.querySelectorAll(".msg.user")) : [];
    if (!msgs.length) {
      const empty = document.createElement("div");
      empty.className = "said-empty";
      empty.textContent = "这个会话里你还没说过话。";
      saidMenu.appendChild(empty);
      return;
    }
    // 正读着的那一条：窗格最上头露出来的那句；贴着底时算最后一句。
    let cur = 0;
    if (st.stickToBottom) {
      cur = msgs.length - 1;
    } else {
      const top = st.paneEl.scrollTop + 12;
      for (let i = 0; i < msgs.length; i++) { if (msgs[i].offsetTop <= top) { cur = i; } }
    }
    const frag = document.createDocumentFragment();
    msgs.forEach((el, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pk-item said-item" + (i === cur ? " current" : "");
      const no = document.createElement("span");
      no.className = "said-no";
      no.textContent = String(i + 1);
      const text = document.createElement("span");
      text.className = "said-text";
      text.textContent = messagePreviewText(el);
      row.append(no, text);
      row.addEventListener("click", () => {
        closeSaidMenu();
        jumpToUserMessage(st, el);
      });
      frag.appendChild(row);
    });
    saidMenu.appendChild(frag);
  }

  function toggleSaidMenu() {
    if (saidOpen()) { closeSaidMenu(); return; }
    openSaidMenu();
  }

  function openSaidMenu() {
    const st = activeSession();
    if (!st || !saidMenu) { return; }
    // 输入框上头那几个下拉（@ 文件、# 会话、/ 命令）同一时刻只开一个
    hideFileMenu();
    hideHashMenu();
    closeSlashMenu();
    renderSaidList(st);
    saidMenu.classList.remove("hidden");
    if (saidBtn) { saidBtn.classList.add("on"); }
    // 清单长了先把正读着的那一条摆到眼前（不用自己往下翻）
    const cur = saidMenu.querySelector(".pk-item.current");
    if (cur) { saidMenu.scrollTop = Math.max(0, cur.offsetTop - saidMenu.clientHeight / 2); }
  }

  function closeSaidMenu() {
    if (!saidMenu || !saidOpen()) { return; }
    saidMenu.classList.add("hidden");
    saidMenu.innerHTML = "";
    if (saidBtn) { saidBtn.classList.remove("on"); }
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
      // 收尾就走最后一次「按块」渲染（跟流式期间同一条路），不再整段重画：
      // 整段重画要多解析一次全文、多高亮一次、把整块 DOM 换掉（长回复时看得出来），
      // 还会把已经挂进 .md 的符号链接抹掉。切不了块的情况（引用式定义 / HTML 块）
      // 由 renderStreamBody 内部退回整段渲染，跟流式期间一个规矩。
      renderStreamBody(st, st.currentAssistant.raw || "");
      // 流式期间不给活跃消息挂符号链接（见 symbolSet 那段），收尾这里补上：
      // 不然要等下一次符号集合变化才可点。
      applySymbolLinks(st.currentAssistant.el);
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
    endRunningLine(st);       // 这一批工具过去了：还在留的那条位置到此为止（见 endRunningLine）
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
    endRunningLine(st);       // 这一批工具过去了：还在留的那条位置到此为止（见 endRunningLine）
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
   *  各种工具标签共用这一套。 */
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
  // 只有一次时不写数字）。标签就停在**第一次**出现这个名字的位置；中间夹了别的工具调用（不同名的）
  // 不影响它攒数，数都记在同一个标签上。
  // 鼠标停上去，提示框里把它们一条一条列出来（调用 + 结果），见 fillGroupTip。
  //
  // 不合并的（每次单独一个标签，连着来也各占一个）：
  //   · taba / taba_stop / taba_peek（派子会话）—— 每次派的活不一样，各自单独看一眼更清楚；
  //   · 结果带图的 read —— 是不是图要等结果回来才知道，那条到了会从组里摘出去，
  //     在对话里铺成一整块图（见 removeEntryFromGroup）。
  // write / edit 也跟别的工具一样按名字收（改了好几处就收成「edit ×3」）：标签上只有工具名和次数，
  // 改了哪个文件、diff、跳转 / 回滚都在悬浮提示里一条条看（见 buildEditCard）。
  // 一条正文（或用户消息）到来就换行、另起一批，上批的标签不再攒数。
  const NO_MERGE_TOOLS = new Set(["taba", "taba_stop", "taba_peek"]);
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
    // 问话卡片有时候比这条工具行先到（两条通道各有快慢）：把它挪到这一行下面
    dockAskCardToRow(st, toolCallId, tag.parentElement);
    if (toolCallId) { st.pendingToolTags.set(toolCallId, tag); }
    syncRunningLine(st);   // 这条在跑：末尾那行跟着写上它
    scrollToBottom(st);
  }

  /** 往这一批里加一条调用：同名就并到已有那个标签上（标签停在第一次调用的位置），
   *  没见过的名字新开一个标签。tipFill（可选）：这一条在提示框里怎么画，不传就按默认的
   *  「调用一行 + 结果一块」画（write / edit 自带一块，见 buildEditCard）。 */
  function addToolToGroup(st, toolName, argStr, toolCallId, tipFill) {
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
      tag._tipGroup = g;   // 提示框那边靠它看这组还在不在长（见 tipContentIsGrowing）
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
      tipFill: tipFill || null,
      resultText: "",
      meta: {},
      isError: false,
      done: !toolCallId, // 无 id 的静态调用无结果事件，按已完成处理
    };
    g.entries.push(entry);
    if (toolCallId) { st.toolGroupEntries.set(toolCallId, entry); }
    syncGroupTag(st, g);
    // 问话卡片有时候比这条工具行先到（两条通道各有快慢）：把它挪到这一行下面
    dockAskCardToRow(st, toolCallId, g.row);
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
  function syncGroupTag(st, g) {
    g.nameEl.textContent = " " + (g.name || "");
    const total = g.entries.length;
    g.countEl.textContent = total > 1 ? String(total) : "";
    g.tag.classList.toggle("running", g.entries.some((e) => !e.done));
    g.tag.classList.toggle("error", g.entries.some((e) => e.isError));
    // 一组里的改动都回滚了，整颗标签才划掉（只有 write / edit 会被回滚，见 buildEditCard）
    g.tag.classList.toggle("reverted", g.entries.length > 0 && g.entries.every((e) => e.reverted));
    refreshTagTipIfShowing(g.tag);
    syncRunningLine(st);   // 这组里有在跑的：末尾那行跟着变
  }

  /** 合并标签的提示内容：一条调用一行（输入），下面紧跟它的结果（输出），一条条排下来。 */
  function fillGroupTip(g, content) {
    content.textContent = "";
    g.entries.forEach((e, i) => {
      // write / edit 那一条自带一块画法（文件名 + diff + 按钮）：整块交给它自己画
      if (e.tipFill) { e.tipFill(content, i > 0); return; }
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
      syncRunningLine(st);
    } else {
      syncGroupTag(st, g);
    }
    mountToolImageBlock(st, { toolName: entry.name, argStr: entry.argStr, tipCall: entry.tipCall, toolCallId: entry.id }, images);
  }

  // ==================== 正在跑的那一条 ====================
  // 工具标签只说得出工具名：命令行、读哪个文件、grep 找什么都在提示框里，不悬浮就看不见。
  // 正在跑的那一条不一样：它在当前这批标签下面单占一行，把这一行的摘要直接写出来
  // （bash 就是「$ 命令」）。同时跑几条就排几行。
  // 不出这行的两种：think（思考，内容在提示框里看）与 ask_choice（问话卡片本来就铺在消息流里，
  // 而且它要等人答完才算跑完，摆一行「正在跑」只会碍事）。
  //
  // 退场分两步走 —— 一串很快跑完的调用（读文件、grep，一条几十毫秒）不该让这行一闪一闪：
  // 出现、消失、又出现，下面的内容跟着上下跳。
  //   · 先留字：一条都不在跑之后，写着的那条再留 RUNNING_LINE_LINGER_MS；这几十毫秒里下一批
  //     工具多半就接上了，接上就一直写着、只是换个名字，看着是一条连着变的（见 expireRunningLine）；
  //   · 位置留到这一批真过去：到点之后字淡出去（见 chat.css 的 .tool-running-item.gone），
  //     淡完这块地方还占着（高度不变，下面不动），等下面出了正文 / 问话卡片（这一批工具过去了），
  //     或者这一轮跑完，才整条连位置一起收掉（见 endRunningLine）。
  //
  // 一行写不完的（长命令行）：字自己慢慢横向滚，只往一个方向（从头滚到末尾，到头停一下再从开头来，
  // 见 rollRunningText 与 chat.css 的 tr-roll），不然一颗「bash」加小半条命令就完了，看不出来在跑什么。
  const RUNNING_LINE_SKIP = new Set([THINKING_NAME, "ask_choice"]);
  const RUNNING_LINE_LINGER_MS = 300;
  const RUNNING_ROLL_MIN_PX = 4;    // 溢出这几个像素以内不算「放不下」（末尾省略号那点宽度，不值当滚）
  const RUNNING_ROLL_SPEED = 30;    // 放不下的那行字自己滚动的快慢：每秒 30 像素（慢慢地滚）
  const RUNNING_ROLL_SWEEP = 0.91;  // 一趟里走的时间占多少（另 9% 是两头停的那一下，见 chat.css 的 tr-roll）

  /** 现在还有哪些调用在跑、各自那一行摘要（一条一行，按页面上标签的顺序）。
   *  直接看页面上那些转圈的标签：批次换了行、重放历史都不影响 —— 写出来的跟看到的是同一份。 */
  function runningCallTexts(st) {
    const out = [];
    for (const tag of st.paneEl.querySelectorAll(".tool.running")) {
      const g = tag._tipGroup;
      if (g) {
        for (const e of g.entries) {
          if (!e.done && !RUNNING_LINE_SKIP.has(e.name)) { out.push(e.tipCall || e.name); }
        }
        continue;
      }
      if (tag._done === false && !RUNNING_LINE_SKIP.has(tag._toolName)) {
        out.push(tag._tipCall || tag._toolName || "");
      }
    }
    return out;
  }

  /** 画/更新「正在跑」的那一行：贴在当前这批工具标签下面（新一轮工具行上来就跟着挪过去）。
   *  没有在跑的怎么退场见上面那段说明（先留字、位置留到这一批过去）。 */
  function syncRunningLine(st) {
    // 往暂存区补更早的历史时（「加载更早」那批）不碰：那块还没在页面上（同 placeEndHint）
    if (!st || !st.paneEl || st._stage === st.paneEl) { return; }
    const texts = runningCallTexts(st);
    if (!texts.length) {
      // 一条都不在跑了：先让写着的那条再留一会儿（下一批多半这会儿就接上），到点见下面那个函数。
      // 本来就没这条（这一批没调过工具）什么都不用做。
      if (st.runningLine && !st.runningLineTimer) {
        st.runningLineTimer = setTimeout(() => { st.runningLineTimer = 0; expireRunningLine(st); }, RUNNING_LINE_LINGER_MS);
      }
      return;
    }
    if (st.runningLineTimer) { clearTimeout(st.runningLineTimer); st.runningLineTimer = 0; }
    if (!st.runningLine) {
      st.runningLine = document.createElement("div");
      st.runningLine.className = "msg tool-running";
    }
    const line = st.runningLine;
    line.textContent = "";
    const toMeasure = [];
    for (const text of texts) {
      const item = document.createElement("div");
      item.className = "tool-running-item";
      item.insertAdjacentHTML("afterbegin", GEAR_SVG);
      const t = document.createElement("span");
      t.className = "tr-text";
      t.textContent = text;
      item.appendChild(t);
      line.appendChild(item);
      toMeasure.push([t, text]);
    }
    placeRunningLine(st, line);
    // 量「这一行放不放得下」得等它排到页面上（新起一条时上面那一步才把它插进去），
    // 所以挪完位置再逐条看一眼：放不下的改成自己滚（见 rollRunningText）。
    for (const [t, text] of toMeasure) { rollRunningText(t, text); }
  }

  /** 这一条的字一行放得下就不动（末尾不够就省略号）；放不下就让它自己慢慢横向滚：
   *  滚的距离就是溢出的那些像素（--tr-shift），快慢按固定速度算（--tr-dur），动画见 chat.css 的 tr-roll。
   *  一趟的时长按「走的部分每秒 30 像素」倒推：两头停的那一下也算在里面（RUNNING_ROLL_SWEEP）。 */
  function rollRunningText(t, text) {
    t.textContent = text;
    t.classList.remove("roll");
    t.style.removeProperty("--tr-shift");
    t.style.removeProperty("--tr-dur");
    const over = t.scrollWidth - t.clientWidth;
    if (over < RUNNING_ROLL_MIN_PX) { return; }
    const run = document.createElement("span");
    run.className = "tr-run";
    run.textContent = text;
    t.textContent = "";
    t.appendChild(run);
    t.classList.add("roll");
    t.style.setProperty("--tr-shift", -over + "px");
    t.style.setProperty("--tr-dur", Math.max(1, over / RUNNING_ROLL_SPEED / RUNNING_ROLL_SWEEP) + "s");
  }

  /** 留的那一会儿到点了、还是一条都没在跑：这一批过去了就把整条收掉，没过去就把字清掉、位置留着。
   *  「过去了」看它跟的那排标签还是不是当前这排：下面是正文 / 问话卡片了（currentToolRow 被清掉），
   *  或者已经换到新的一排上，都算这一批过去了。 */
  function expireRunningLine(st) {
    const line = st.runningLine;
    if (!line || !st.paneEl || runningCallTexts(st).length) { return; }
    // 它跟的那排标签没了（那排标签空了被收掉）、或者已经不是当前这排（下面是正文 / 问话卡片了）：
    // 这一批过去了，整条连位置一起收。
    const rowGone = line._row && line._row.parentElement !== st.paneEl;
    if (rowGone || st.currentToolRow !== line._row) { dropRunningLine(st); return; }
    // 这一批还没过去（下一条工具随时可能来）：字淡掉，位置留着 —— 那个盒子还在页面上、还占着
    // 那条的高度（淡的是里面写着的东西，不是把盒子拿走），下面不会跟着上下跳。
    for (const item of line.children) { item.classList.add("gone"); }
  }

  /** 把这条整条收掉（连位置一起）：那点还没到 / 还没清的字也一并作废（定时器一并清）。 */
  function dropRunningLine(st) {
    if (!st) { return; }
    if (st.runningLineTimer) { clearTimeout(st.runningLineTimer); st.runningLineTimer = 0; }
    if (st.runningLine) { st.runningLine.remove(); st.runningLine = null; }
  }

  /** 这一批工具过去了（下面出了正文 / 问话卡片，或者这一轮跑完）：把还在留的那条连位置一起收掉。
   *  还有工具在跑就不收 —— 那说明这一批还没过去，收掉马上又得开一条，正是要避免的那种一闪。 */
  function endRunningLine(st) {
    if (!st || !st.paneEl || st._stage === st.paneEl) { return; }
    if (runningCallTexts(st).length) { return; }
    dropRunningLine(st);
  }

  /** 把这条摆到它该在的地方：当前这批标签的下面。_row 记着它跟的是哪排标签（判断这一批过没过去
   *  用它，见 expireRunningLine）—— 来了一段正文之后它就待在原地、_row 不动，那排标签不再是
   *  当前那排，这一批就算过去了。 */
  function placeRunningLine(st, line) {
    const row = st.currentToolRow;
    if (row && row.parentElement === st.paneEl) {
      // 当前这批标签的下面；新一轮工具行上来（上一条正文之后又调了工具）就跟着挪过去。
      // 问话卡片也挂在这一行下面（见 dockAskCardToRow）：这条排在卡片后面，两边不抢位置。
      let after = row;
      while (after.nextElementSibling && after.nextElementSibling.classList.contains("ask-card")) { after = after.nextElementSibling; }
      if (line.previousElementSibling !== after) { after.after(line); }
      line._row = row;
      return;
    }
    // 手头没有当前工具行（刚来了一段正文，或者问话卡片把行收掉了）：就待在原地
    // —— 它跟的是它那批标签，不往新内容下面钻（后一条工具调用开了新行时才挪过去）。
    if (line.parentElement === st.paneEl) { return; }
    // 还没挂上页面（整屏重画之后头一条就是还在跑的调用）：挂在消息流末尾
    line._row = row || null;
    const tail = st.endHintRow;
    if (tail && tail.parentElement === st.paneEl) { st.paneEl.insertBefore(line, tail); return; }
    st.paneEl.appendChild(line);
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
  // 模型的思考（reasoning）名字固定「think」，跟同名工具一样收成一颗标签（次数记着几段），
  // 内容只在提示框里看（标签上不露文字）。正在想的那一段挂在 st.thinkingEntry 上，
  // 增量来一条往它上面加一条；收尾见 endThinking。
  //
  // 末尾专治：有些 provider 是先把正文流完、最后才把整段思考一起送过来，那段思考落在消息流末尾
  // 就成了孤零零一颗，看着跟上面那段回复没关系。这种「本段消息末尾补来的一段思考」在这一轮跑完时
  // 并回本段那颗 think（见 foldTailThinking）：
  //   · 归拢的范围是本段消息（上一条用户气泡之后的这一段回复），本段第一颗 think 就是并的目标
  //     （st.segmentThinking）；
  //   · 只在它后面真的什么都没有（末尾）时才并：后面还有正文或工具的，它就在原位待着 ——
  //     那是「这一段之后又想了一下」，位置本身就是信息（st.tailThinking 记着这颗候选）。

  /** 本段新开了一条思考（不是并进已有那颗、也不是接着在长的那条）：记下本段那颗 think 与末尾候选。 */
  function noteThinkingEntry(st, entry) {
    const g = entry.group;
    const seg = st.segmentThinking;
    const segAlive = seg && seg !== g && seg.tag.parentElement === seg.row && seg.row.parentElement === st.paneEl;
    if (!segAlive) {
      // 这一段还没有过思考：它就是本段那颗；末尾这一颗本来就是它，没什么可并的
      st.segmentThinking = g;
      st.tailThinking = null;
      return;
    }
    st.tailThinking = g;
  }

  /** 模型开始想了：在工具行里开出「think」这个条目（已经在想就直接用现成的那条）。 */
  function startThinking(st) {
    if (st.thinkingEntry) { return st.thinkingEntry; }
    hideEmptyHint(st);
    const entry = addToolToGroup(st, THINKING_NAME, "", "");
    // 没有 callId 的条目默认按完成（见 addToolToGroup）：这一段落还在跑，得改回来
    entry.done = false;
    entry.tipCall = THINKING_NAME;
    noteThinkingEntry(st, entry);
    st.thinkingEntry = entry;
    syncGroupTag(st, entry.group);
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
      noteThinkingEntry(st, entry);
    }
    if (st.thinkingEntry === entry) { st.thinkingEntry = null; }
    entry.done = true;
    if (text) { entry.resultText = text; }
    syncGroupTag(st, entry.group);
    scrollToBottom(st);
  }

  /** 末尾那颗 think 还在不在消息流的最末尾（后面没有正文、没有工具；末尾那颗胶囊之类的不算）。 */
  function isLastInStream(st, el) {
    for (let n = el; n && n !== st.paneEl; n = n.parentElement) {
      for (let sib = n.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (sib.classList.contains("end-hint-row") || sib.classList.contains("msg-endhint") || sib.classList.contains("empty-hint") || sib.classList.contains("history-more")) { continue; }
        return false;
      }
    }
    return true;
  }

  /** 一轮跑完（或整屏重画收尾）时看一眼消息流末尾：末尾那颗候选真的是末尾（它后面什么都没有），
   *  就把它并回本段那颗 think —— 不在末尾留一颗孤零零的。后面来了正文 / 工具的，它就在原位。 */
  function foldTailThinking(st) {
    const tail = st.tailThinking;
    st.tailThinking = null;
    if (!tail || st.streaming) { return; }   // 还在生成（或者开了新的一段）：以后可能还有东西
    if (tail.tag.parentElement !== tail.row || tail.row.parentElement !== st.paneEl) { return; }
    if (!isLastInStream(st, tail.tag)) { return; }
    const target = st.segmentThinking;
    const targetAlive = target && target !== tail && target.tag.parentElement === target.row && target.row.parentElement === st.paneEl;
    if (!targetAlive) {
      // 本段那颗不在了（例如刚整屏重画过）：这一颗自己就是本段那颗
      st.segmentThinking = tail;
      return;
    }
    if (st.thinkingEntry && st.thinkingEntry.group === tail) { st.thinkingEntry = null; }
    if (tagTipTag === tail.tag) { hideTagTip(); }   // 正开着这颗的提示框：标签要收掉了，一块收
    // 本段那颗的最后一条还是空的（provider 只发了「开始想了」，字到收尾才给）：这一段的文本就
    // 补进那一条 —— 同一段思考别因为来得晚就占两条（不然收回来还得带个空行）。
    const last = target.entries[target.entries.length - 1];
    const only = tail.entries.length === 1 ? tail.entries[0] : null;
    if (last && !(last.resultText || "").trim() && only && (only.resultText || "").trim()) {
      last.resultText = only.resultText;
      last.done = true;
      tail.entries.length = 0;
    } else {
      for (const e of tail.entries) { target.entries.push(e); }
      tail.entries.length = 0;
    }
    dropToolTag(st, tail.tag);   // 末尾那颗收掉；它那条行空了连行一起收
    syncGroupTag(st, target);
    scrollToBottom(st);
  }

  // ==================== 完整模式：TUI 风格工具卡片 ====================
  // 有定制调用行摘要的工具（与 pi TUI 一致），其余工具回退为加粗工具名 + pretty JSON 参数。
  const CUSTOM_CALL_TOOLS = new Set(["bash", "grep", "find", "ls", "read"]);
  const TOOL_PREVIEW_LINES = 6; // 结果预览行数（同 TUI BASH_PREVIEW_LINES +1，因底部截断标记更紧凑）

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
  // 还在长的内容（正在想的思考、正在跑的工具）多久重画一次。
  // 为什么不像别的更新那样“一变就重画”：重画一次等于把提示框内容整个重排一次，代价随内容长度涨
  // （上十万字的思考一次就好几毫秒），思考/工具的增量却是一秒几十条 —— 每条都来一次就能把主线程占满，
  // 卡到浏览器报「页面无响应」（复现与量法见 dev/thinkTipPerf.js）。所以长的内容按固定间隔重画，
  // 短内容（几百字，排版不到一毫秒）照旧每变必画。
  const TAG_TIP_STREAM_MIN_CHARS = 4000;
  const TAG_TIP_STREAM_INTERVAL_MS = 300;
  let tagTipEl = null;      // 外框
  let tagTipContent = null; // 内容区（可滚动）
  let tagTipTimer = 0;      // 电脑上的悬浮延迟计时
  let tagTipHideTimer = 0;  // 电脑上的鼠标离开宽限计时
  let tagTipPaintTimer = 0; // 节流：攒着的下一次重画（下一帧再定画不画）
  let tagTipPaintAt = 0;    // 上一次重画的时刻（performance.now）
  let tagTipFollow = true;  // 还在长的内容要不要跟着贴底（用户往回滚过就不跟了）
  let tagTipTag = null;

  function cancelTagTipPaint() {
    if (tagTipPaintTimer) { cancelAnimationFrame(tagTipPaintTimer); tagTipPaintTimer = 0; }
  }
  function hideTagTip() {
    cancelTagTipPaint();
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
    // 自定义内容钩子（write / edit 那一条用：标题行 + diff / 写入预览 + 跳转 / 回滚按钮）
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
        // 用户自己往回滚了（滚到离底还远的地方）就不再跟着新内容往下走
        tagTipContent.addEventListener("scroll", () => {
          if (tagTipContent.scrollHeight - tagTipContent.scrollTop - tagTipContent.clientHeight > 8) { tagTipFollow = false; }
        });
      }
      tagTipEl.classList.remove("hidden");
      tagTipFollow = true;   // 这次打开从“跟着最新一段走”开始
      paintTagTip(tag, tipContentIsGrowing(tag));
    };
    // 触屏设备没有悬浮：点一下是明确动作，立即显示；电脑上悬浮短暂停留后再显示
    if (IS_TOUCH_DEVICE) { render(); } else { tagTipTimer = setTimeout(render, TAG_TIP_DELAY_MS); }
  }
  /** 显示期间内容更新（思考增量、结果刚到）时，刷新正在显示的提示内容与位置。
   *  内容还在长、又已经很长时按 TAG_TIP_STREAM_INTERVAL_MS 节流（见上面常量的说明）。 */
  function refreshTagTipIfShowing(tag) {
    if (tagTipTag !== tag || !tagTipEl || tagTipEl.classList.contains("hidden")) { return; }
    const growing = tipContentIsGrowing(tag);
    if (growing) {
      const wait = TAG_TIP_STREAM_INTERVAL_MS - (performance.now() - tagTipPaintAt);
      if (wait > 0) {
        // 还没到该画的点：先攒着，下一帧再定（这几帧里到的增量就并成一次重画）
        if (!tagTipPaintTimer) {
          tagTipPaintTimer = requestAnimationFrame(() => {
            tagTipPaintTimer = 0;
            if (tagTipTag === tag && tagTipEl && !tagTipEl.classList.contains("hidden")) { refreshTagTipIfShowing(tag); }
          });
        }
        return;
      }
    }
    paintTagTip(tag, growing);
  }
  /** 这个标签还在长吗：内容已经攒长了，而且这一条（这一组）还有在跑的。
   *  合并组看组里的条目（think、同名工具）；单独一个标签的（taba 这类不合并的）看它自己。 */
  function tipContentIsGrowing(tag) {
    const g = tag._tipGroup;
    if (g) {
      if (!g.entries.some((e) => !e.done)) { return false; }
      let chars = 0;
      for (const e of g.entries) { chars += (e.resultText || "").length + (e.tipCall || "").length; }
      return chars >= TAG_TIP_STREAM_MIN_CHARS;
    }
    if (tag._done !== false) { return false; }
    return ((tag._tipBody || "").length + (tag._tipCall || "").length) >= TAG_TIP_STREAM_MIN_CHARS;
  }
  /** 真画一次：填内容、量尺寸、摆好位置。followNewest：还在长的内容让内容区跟着贴底。 */
  function paintTagTip(tag, followNewest) {
    tagTipPaintAt = performance.now();
    fillTagTip(tag);
    placeTagTip(tagTipEl, tag);
    // 跟着贴底：新想到的那段不会落在视野外；用户往回滚过就不跟（见 tagTipFollow）
    if (followNewest && tagTipFollow) { tagTipContent.scrollTop = 1e9; }   // 夹到最大：没有读，就不会逼出一次同步重排
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

  /** 结果区图片块：缩略图 + 点击放大；后端对超大图只传 tooLarge 占位，
   *  对“首屏没带过来”的图只传 onDemand 占位（点一下再单独取，见 sessionRuntime 的图片预算）。 */
  function renderResultImages(resultEl, images, card, at) {
    if (!Array.isArray(images) || images.length === 0) { return; }
    const wrap = document.createElement("div"); wrap.className = "tc-images";
    images.forEach((img, index) => { wrap.appendChild(resultImageNode(img, card, at, index)); });
    resultEl.appendChild(wrap);
  }

  /** 一张结果图：真带数据就画出来，占位（过大 / 没带过来）就单独处理。 */
  function resultImageNode(img, card, at, index) {
    if (img && img.onDemand) { return resultImageChip(img, at, index); }
    if (!img || img.tooLarge || typeof img.data !== "string" || !img.data) {
      const ph = document.createElement("div"); ph.className = "tc-img-too-large";
      const mb = img && typeof img.bytes === "number" ? (img.bytes / 1048576).toFixed(1) + " MB" : "超过上限";
      ph.textContent = "[图片过大 " + mb + "，未内联显示]";
      return ph;
    }
    return resultImageEl(img, card);
  }

  /** 真图那个 <img>：点击放大，图片尺寸到了再把宽高补到工具行上。 */
  function resultImageEl(img, card) {
    const el = document.createElement("img");
    el.className = "tc-img";
    el.src = "data:" + (img.mimeType || "image/png") + ";base64," + img.data;
    el.title = "点击放大";
    el.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(el.src); });
    el.addEventListener("load", () => { applyImageDims(card, el.naturalWidth, el.naturalHeight); }, { once: true });
    return el;
  }

  /**
   * “首屏没带过来”的那张图的占位：点一下才单独去后端取这一张。
   *
   * 为什么要有它：手机上刷新一次，一屏的图（都是截图）动不动好几 MB，界面得空着等传完；
   * 现在只带最近几张，更早的就在这儿等你想看时再取。
   */
  function resultImageChip(img, at, index) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tc-img-ondemand";
    const bytes = img && typeof img.bytes === "number" ? img.bytes : 0;
    btn.textContent = "点开看这张图" + (bytes > 0 ? "（约 " + formatBytes(bytes) + "）" : "");
    const toolCallId = at && typeof at.toolCallId === "string" ? at.toolCallId : "";
    if (toolCallId) { btn.setAttribute("data-result-img", imageKey(toolCallId, index)); }
    btn.addEventListener("click", () => {
      if (btn.disabled || !toolCallId || !at.st) { return; }
      btn.disabled = true;
      btn.textContent = "正在取图…";
      vscode.postMessage({ type: "loadResultImage", sessionId: at.st.id, toolCallId: toolCallId, index: index });
    });
    return btn;
  }

  /** 占位与回来的那张图靠这个对上（同一张可能有好几处：重画过 / 暂存区里还有一份）。 */
  function imageKey(toolCallId, index) {
    // 属性值里放不了引号与反斜杠（工具调用 id 是 pi 给的，这里只是防万一）
    return String(toolCallId).replace(/["\\]/g, "") + "#" + index;
  }

  /** 字节数写成短的给人看（大约就行）：500 KB / 1.2 MB。 */
  function formatBytes(n) {
    if (!(n > 0)) { return ""; }
    if (n < 1024 * 1024) { return Math.max(1, Math.round(n / 1024)) + " KB"; }
    return (n / 1048576).toFixed(1) + " MB";
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
   * （见 toolTagHost）。调用方传 at：{ toolName, argStr, tipCall, toolCallId }（toolCallId 用来
   * 认“首屏没带过来的那张图”，见 resultImageChip）。
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
    renderResultImages(block, images, block, { st: st, toolCallId: call.toolCallId });
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

  /**
   * write / edit 的一次调用：跟别的工具一样按名字收进那条工具调用行（连着改几处就收成
   * 「edit ×3」，标签上只有工具名和次数），改了哪个文件、diff、跳转 / 回滚都在悬浮提示里，
   * 一条调用一块（见 fillEntry）。调用方拿到的是这一条自己的把手：结果回来、回滚了各调一下
   * （见 editCardResult / editReverted）。
   */
  function buildEditCard(st, toolName, label, filePath, toolCallId, argStr) {
    hideEmptyHint(st);
    let pendingResult = null;   // 结果（含 diff）：提示框随取随画
    let resultDone = false;
    let reverted = false;

    /** 提示框里属于这一条的那一块：标题行（工具名 + 路径 + 状态，右边跟「跳转 / 回滚」排在同一行）
     *  + 下面的 diff / 写入预览。isNext：这一条不是组里的第一条，往上拉开距离（跟别的工具那一条同一个类）。 */
    function fillEntry(content, isNext) {
      const head = document.createElement("div");
      head.className = "tag-tip-call tag-tip-head" + (isNext ? " tag-tip-call-next" : "");
      const title = document.createElement("span");
      title.className = "tag-tip-title";
      title.textContent = toolName + " " + (label || filePath || "") + (reverted ? "（已回滚）" : "");
      head.appendChild(title);
      content.appendChild(head);
      if (resultDone && pendingResult) {
        if (pendingResult.isError) {
          const err = document.createElement("div");
          err.className = "tip-err";
          err.textContent = pendingResult.errorText || "失败";
          content.appendChild(err);
        } else {
          // 按钮跟标题排在同一行（在标题右边）：write 给「跳转」，edit 成功且可回滚给「回滚」
          if (toolName === "write" && filePath) {
            const jumpBtn = document.createElement("span"); jumpBtn.className = "et-jump"; jumpBtn.innerHTML = '跳转 ' + ICONS["link-external"];
            // 在这儿打开的是哪儿：跟正文里的文件链接同一处分流（见 openFileForUser）
            jumpBtn.title = (fileSidebar.root ? "在文件侧边栏里打开 " : "在编辑器中打开 ") + (label || filePath);
            jumpBtn.addEventListener("click", (e) => { e.stopPropagation(); openFileForUser(filePath, 1); });
            head.appendChild(jumpBtn);
          } else if (pendingResult.canRevert && toolCallId && !reverted) {
            const revertBtn = document.createElement("span"); revertBtn.className = "et-revert"; revertBtn.innerHTML = ICONS.discard + ' 回滚';
            revertBtn.title = "将文件恢复到本次修改前的内容";
            revertBtn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "revertEdit", sessionId: st.id, toolCallId }); });
            head.appendChild(revertBtn);
          }
          // 改的什么接在标题行下面：edit 显示完整 diff；write 显示写入内容预览（前 10 行）
          if (toolName !== "write" && pendingResult.diff) {
            content.appendChild(renderDiffBlock(st, pendingResult.diff, filePath));
          } else if (toolName === "write") {
            const pv = buildWritePreviewEl(argStr);
            if (pv) { content.appendChild(pv); }
          }
        }
      } else if (toolCallId) {
        const loading = document.createElement("div");
        loading.className = "tip-loading";
        loading.textContent = "生成中…";
        content.appendChild(loading);
      }
    }
    // 挂进那一批（同名收成一个标签）：提示框里那一块交给上面 fillEntry 画
    const entry = addToolToGroup(st, toolName, argStr, toolCallId, fillEntry);

    return {
      setResult(msg) {
        resultDone = true;
        pendingResult = msg;
        entry.done = true;
        entry.isError = !!msg.isError;
        if (entry.id) { st.toolGroupEntries.delete(entry.id); }   // 结果到了：跟别的工具一样从待填表里撤掉
        syncGroupTag(st, entry.group);   // 条数 / 转圈 / 标红跟着重算，提示框开着就重画
      },
      markReverted() {
        reverted = true;
        entry.reverted = true;
        syncGroupTag(st, entry.group);   // 这一组里的改动都回滚了，整颗标签才划掉（见 syncGroupTag）
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
  /** 当前会话在不在生成：Esc 与末尾那颗「停止生成」共用这一处判断。 */
  function activeSessionStreaming() {
    const st = activeSession();
    return !!(st && st.streaming);
  }

  /** 输入框那一带的按钮随会话状态刷新（现在只剩消息流末尾那两颗，见 syncEndHint）。 */
  function syncComposerButtons() {
    syncEndHint(activeSession());
  }

  /** 消息流末尾那颗胶囊上写的是什么。 */
  const END_HINT_CONTINUE = "继续";
  const END_HINT_STUCK = "卡住了";

  /**
   * 消息流末尾那颗胶囊 —— 按当前会话的状态换脸：
   *
   *   - 会话闲着、能接着往下走时是「继续」：点它直接发一条“继续”（不走输入框，打了一半的字、
   *     贴的图都留着）；
   *   - 模型正在回复时是「卡住了」：点它把这一轮终止掉（跟按 Esc 一样），停稳之后补发一条
   *     “卡住了”—— 一句话：停下来，然后告诉它卡住了。这件事由后端记着（见 chatControllerBase /
   *     sessionRuntime 的 abortThenSend）：点完刷新页面、关掉页面，那句话照样发得出去。
   *
   * 为什么长在消息流里：摆在输入框那一带时，它要么占着打字的地方（以前那颗带字的胶囊），
   * 要么跟“停止生成”挤同一格。挂在会话自己的消息流末尾就谁都不挡 —— 位置跟着对话走，
   * 生成中也是：新内容一上来由 placeEndHint 把它挪回末尾。
   *
   * 每个会话一颗（各在各的消息流里）。空会话（一条消息都没有）、会话还没就绪、正在加载历史
   * 时都不露面。
   */
  function syncEndHint(st) {
    if (!st || !st.paneEl) { return; }
    // 会话还没就绪（pi 进程刚起）时点了也发不出去：这时候不露面。
    // “有没有可接着往下走的对话”只看用户与助手两种消息：会话刚建时窗格里那句
    // “pi 已启动，可以开始对话。”是系统消息，不能算 —— 空会话里摆一颗“继续”没意义。
    const touched = st.paneEl.querySelector(".msg.user, .msg.assistant");
    const mode = (!st.piReady || !touched) ? ""
        : st.streaming ? "stuck"
            : st.loading ? "" : "continue";
    const row = st.endHintRow || (st.endHintRow = makeEndHintRow(st));
    const el = st.endHintEl;
    if (el.dataset.mode !== mode) { setEndHintMode(el, mode); }
    el.classList.toggle("hidden", !mode);
    // 「卡住了」旁边那颗停止生成：生成中才露面（只有方块图标，不写字）
    const stop = st.endHintStopEl;
    const showStop = !!(st.piReady && st.streaming);
    if (stop) { stop.classList.toggle("hidden", !showStop); }
    row.classList.toggle("hidden", !mode && !showStop);
    if (mode || showStop) { placeEndHint(st); }
  }

  /** 给末尾那颗胶囊换脸（继续 / 卡住了）：点了哪一面之后走哪条路，就看这里记下的状态。 */
  function setEndHintMode(el, mode) {
    el.dataset.mode = mode;
    if (mode === "stuck") {
      el.title = "停掉这一轮，然后发一条“卡住了”";
      // 不挂方块图标：旁边那颗「停止生成」就是方块，两颗方块挨着看不清谁是谁
      el.innerHTML = "<span>" + END_HINT_STUCK + "</span>";
    } else {
      el.title = "发送一条“继续”";
      el.innerHTML = ICONS["arrow-right"] + "<span>" + END_HINT_CONTINUE + "</span>";
    }
  }

  /** 末尾那颗胶囊永远跟在最新一条内容后面：新消息一上来它就落到前头去了，顺手挪回末尾。
   *  往暂存区补更早的历史时（「加载更早」那一批）不动：那块不在页面上，挪进去会跟着那批
   *  老消息一起插到顶上去。 */
  function placeEndHint(st) {
    const row = st.endHintRow;
    if (!row || !st.paneEl) { return; }
    if (st._stage && st.paneEl === st._stage) { return; }
    if (row.parentElement !== st.paneEl || st.paneEl.lastElementChild !== row) {
      st.paneEl.appendChild(row);
    }
  }

  /**
   * 建末尾那一行：主胶囊（继续 / 卡住了）与它旁边那颗「停止生成」并排。
   * 停止生成就是主胶囊复制一份、去掉“卡住了”三个字，只留方块图标：点它只是把这一轮停掉
   * （跟按 Esc 一样，不补发“卡住了”），要“停下来再告诉它卡住了”就点旁边那颗。
   * 写什么由当前状态定（见 setEndHintMode）；露面时机与位置由 syncEndHint / placeEndHint 管。
   */
  function makeEndHintRow(st) {
    const row = document.createElement("div");
    row.className = "end-hint-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-endhint";
    setEndHintMode(btn, "continue");
    btn.addEventListener("click", () => {
      const cur = activeSession();
      if (!cur || cur.id !== st.id || !cur.piReady) { return; }
      if (btn.dataset.mode === "stuck") {
        // 这条只在生成中露面，这里是防手快点到的边界情况（这一轮刚跑完的那一下）
        if (!cur.streaming) { return; }
        // 先收起来：手快连点两下会按两遍（等后端的 streamEnd / 别的消息回来再按真实状态算）
        btn.classList.add("hidden");
        // 终止这一轮、停稳之后补发那句“卡住了”，都由后端做（见 abortThenSend）：
        // 点完刷新页面、关掉页面，那句话照样发得出去。
        vscode.postMessage({ type: "abortThenSend", sessionId: cur.id, text: END_HINT_STUCK });
        // 万一点击没送到（连接断了），过一会儿按真实状态重新算
        setTimeout(() => syncEndHint(cur), 1500);
        return;
      }
      // 只在会话就绪且闲着时露面，这里是防手快点到的边界情况（刚开始生成的那一下）
      if (cur.loading || cur.streaming) { return; }
      // 先收起来：手快连点两下会发出两条“继续”（等后端的 userMessage / streamStart 回来再按真实状态算）
      btn.classList.add("hidden");
      vscode.postMessage({ type: "send", sessionId: cur.id, text: END_HINT_CONTINUE, images: [] });
      // 焦点还回输入框：留在按钮上接着按回车会又发一条
      if (!IS_TOUCH_DEVICE) { inputEl.focus(); }
      // 万一点击没送到（连接断了），过一会儿按真实状态重新算
      setTimeout(() => syncEndHint(cur), 1500);
    });
    // 停止生成：跟主胶囊同一个样子，只是不写字（只有方块图标）
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "msg-endhint msg-endhint-stop";
    stop.id = "stopHintBtn";
    stop.title = "停止生成";
    stop.setAttribute("aria-label", "停止生成");
    stop.innerHTML = ICONS["stop-square"];
    stop.addEventListener("click", () => {
      const cur = activeSession();
      if (!cur || cur.id !== st.id) { return; }
      if (!abortActiveTab()) { return; }
      // 先藏起来：等宿主的 streamEnd 回来再按真实状态刷新；万一点击没送到，过一会儿重新算
      stop.classList.add("hidden");
      setTimeout(() => syncEndHint(cur), 1500);
    });
    // 顺序：停止生成（方块）在前，「卡住了」在后
    row.append(stop, btn);
    st.endHintEl = btn;
    st.endHintStopEl = stop;
    return row;
  }

  function updateSendState() {
    // VSCode 里发送/中止只看键盘（Enter 发送、Esc 中止），没有按钮；状态文案由 syncStatus 负责。
    // 网页端（尤其手机）没有 Esc：消息流末尾那一行闲着是「继续」、生成中是「卡住了」加一颗
    // 只有方块的「停止生成」（见 syncEndHint）。
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
    // 左边那一列看的是会话目录里的文件：换了会话就收成一句提示
    resetFileSidebarForSession();
    // 看过了：那颗“有新消息”的小蓝点收掉
    const shown = sessions.get(id);
    if (shown && shown.unread) { shown.unread = false; }
    mountActiveSession();
    closeSaidMenu();   // 清单里排的是上一个会话说过的话：换了会话就收起来
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
   * 不按目录过滤：开着的会话全都在（顶条那颗会话名的下拉、面板的上半共用这一份）。
   */
  function openSessionItems() {
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
      push(st, 0);
      kids.forEach((kid) => { push(kid, 1); });
    });
    return items;
  }

  /**
   * 会话行鼠标停上去的那行提示：标题 + 它的完整目录。
   * 行上不写目录（一份“历史会话”里混着所有工作区的会话）：同名会话靠这个提示分辨。
   */
  function tooltipWithCwd(label, cwd) {
    const name = label || "";
    if (!cwd) { return name; }
    return name ? name + "\n" + cwd : cwd;
  }

  /** 两个路径是不是同一个目录（斜杠、末尾斜杠、大小写都归一化再比）。 */
  function samePath(a, b) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return norm(a) === norm(b);
  }

  /** 拿一个目录当“同一个目录”用的键（跟 samePath 一个规矩）。 */
  function normPathKey(p) {
    return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /** 当前会话跑在哪个目录（面板上“当前工作区”那一行、展开记忆的默认值都看它）。 */
  function activeSessionCwd() {
    const st = activeId ? sessions.get(activeId) : null;
    return st && typeof st.cwd === "string" ? st.cwd : "";
  }

  /** 路径最后一段（面板上那一行写的就是它）；取不出来就用整个路径。 */
  function baseNameOfPath(p) {
    const parts = String(p || "").split(/[\\/]+/).filter((x) => x.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : String(p || "");
  }

  /**
   * 工作区那些行：把“当前会话所在目录”那一行挪到最上面（不标“当前”，只是排第一）。
   *
   * 目录跟着正在看的那个会话走（面板自己不再有“选中的工作区”），所以要在画的时候现算：
   * 切到别的目录的会话，那一行自己跟着换，不用等宿主重推一份。
   * 列表里没有它（比如刚挑了个没跑过会话的新目录）就现造一行，那颗加号照样能点。
   *
   * @param items 宿主给的那些工作区行
   */
  function withCurrentWorkspaceFirst(items) {
    const cwd = activeSessionCwd();
    if (!cwd) { return items; }
    let hit = null;
    const rest = [];
    for (const it of items) {
      if (!hit && samePath(it.file, cwd)) { hit = it; continue; }
      rest.push(it);
    }
    const first = hit || {
      __section: "space", section: "工作区",
      label: baseNameOfPath(cwd), file: cwd, folderPath: cwd,
    };
    return [first].concat(rest);
  }

  /** 把“等确认”那一行撤回去（点取消、点行身切会话、干等超时都走它）：只抹状态，重画交给调用方。 */
  function cancelPendingClose() {
    pendingCloseId = null;
    if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
    pendingCloseTimer = null;
  }

  /** 请求关闭某个会话：第一次点击只是把那一行变成确认条（行尾多一颗勾），再点勾才真关（防误触）。 */
  function askCloseSession(id) {
    if (pendingCloseId !== id) {
      // 点第一下（某一行转成确认条）：就手把清单现在的宽度记下来钉住，
      // 行尾多出一颗勾也不许把整张清单撑宽（钉住的值在 placeSessionMenu 里用）。
      if (sessionMenuOpen && !pendingCloseId) { sessionMenuPin = sessionMenuEl.offsetWidth; }
      pendingCloseId = id;
      if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
      pendingCloseTimer = setTimeout(() => {
        cancelPendingClose();
        refreshOpenSessionsInPicker();
        refreshSessionMenu();
      }, 4000);
      refreshOpenSessionsInPicker();
      refreshSessionMenu();
      return;
    }
    cancelPendingClose();
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

  /**
   * 「项目与会话」下半那一块（工作区 + 展开的组挂着的会话）的内容指纹。
   * 跟 openSessionsSignature 一个用法：跟屏幕上那份一样就不重画那一格。
   * 各组的「正在取 / 还有没有下一批」也要算上：那一组末尾那颗「加载更多」长什么样看它。
   */
  function spaceRowsSignature(view) {
    const st = view.state;
    if (!st) { return ""; }
    const groups = [];
    if (st.groups) { st.groups.forEach((g, key) => { groups.push([key, g.loading ? 1 : 0, g.hasMore ? 1 : 0]); }); }
    return JSON.stringify([
      st.spacesHasMore === true ? 1 : 0, st.spacesLoading === true ? 1 : 0,
      groups, st.items.filter((it) => it.__section !== "open"),
    ]);
  }

  /**
   * 会话增减 / 状态变化 / 确认条状态变化：列表开着就把变了的那一块重画一遍。
   * 三处讲究：
   *  - 只换「正在对话」那一段，后面原样接回去——「加载更多」追加进来的行只存在 st.items 里，
   *    不能拿宿主最初给的那份数据整份重拼，否则点出来的行会被下一次状态推送抹掉；
   *  - 内容跟屏幕上那份一模一样就不画：会话在跑的时候状态推送很密，
   *    白白重画一遍只会把滚动位置顶回顶部；
   *  - 「项目与会话」上下两格（正在对话 / 工作区）各画各的：会话状态一变只重画上半那几行，
   *    下半「工作区」那一块（可能很长）内容没变就一根手指都不碰 ——
   *    常驻那一列整块重画，看着就是整列闪一下。
   */
  function refreshOpenSessionsInPicker() {
    refreshOpenSessionsIn(modalView);
    refreshOpenSessionsIn(dockView);
  }

  /** 一块面板里换掉「正在对话」那一段（这块面板没画着这种内容就什么都不做）。 */
  function refreshOpenSessionsIn(view) {
    const st = view.state;
    if (!st || (st.kind !== "workspace" && st.kind !== "history")) { return; }
    // 两块面板都列全部开着的会话（面板里那一段不跟某个工作区走）
    const openItems = openSessionItems();
    if (st.kind === "workspace") {
      // 「项目与会话」：整串重拼一份（工作区那一块、展开了的组都跟着一起算），
      // 按格比较后只画真的变了的那一格（见 paintWorkspacePanel）。
      rebuildWorkspaceItems(view);
      paintWorkspacePanel(view);
      return;
    }
    const signature = openSessionsSignature(openItems);
    if (signature === view.openSessionsShown) { return; }
    view.openSessionsShown = signature;
    st.items = openItems.concat(st.items.filter((it) => it.__section !== "open"));
    renderPickerItems(view);
  }


  // ==================== 问话卡片（要用户答一句）====================
  //
  // 模型问的选择题（ask_choice）、扩展问的确认 / 输入 / 选一个，都长在会话的消息流里，
  // 不弹浮层、不挡别的会话：插在那条 ask_choice 工具行下面（宿主把工具调用编号一起发来了），
  // 没得插就接在当前内容末尾。答完卡片不消失：就地定住，底下那一套按钮收掉，
  // 选中的那几行留着高亮（自己写的 / 是或否 / 没作答这三种看不出来的才补一行字），
  // 翻回去还看得见当时问了什么、答了什么。
  //
  // 三种长相（宿主给的 card.kind）：
  //   choice   标题 + 几行选项（单选点一行就是答案；多选勾完按「确定」）+ 可选的"自己写"一行
  //            单选底下不留按钮：点一行就走了，自己写那行按回车交；多选留一颗「确定」
  //   confirm  标题 + 说明 + 「是」「否」
  //   prompt   标题 + 一行输入 + 「确定」「取消」
  // 同一个会话可能几块屏同时开着：谁先答算谁的，别的屏上那张由宿主发 askCardDone 定住。
  //
  // 在这块屏上打字答的（在那行输入框里按的回车），答完把光标放回下面那个输入框：接着就能
  // 打字，手机上软键盘也跟着留住（见 submitAskCard）。点选项 / 点按钮答的不动光标。

  /**
   * 这张卡片底下要写的那行结果；空串 = 不用写（选中那几行留着高亮就够了）。
   * 自己写的那句、是 / 否、没作答这三样没法用高亮表示，得写出来。
   */
  function askAnswerText(rec, answer) {
    if (!answer || answer.cancelled === true) { return "没作答"; }
    if (rec.kind === "confirm") { return answer.yes === true ? "你答：是" : "你答：否"; }
    const text = String(answer.text || "").trim();
    if (rec.kind === "prompt") { return text ? "你写的是：" + text : "你没写内容"; }
    // 单选 / 多选：选的是哪几行已经留在那儿亮着了，不用再把它们重说一遍
    return text ? "你自己写的是：" + text : "";
  }

  /**
   * 答完了（自己答的 / 别的屏答的 / 到点）：这张卡片定住。
   * 交互那一块（按钮、输入行、说明）整个收掉 —— 点完就已经回复了，不用留一堆按不动的按钮；
   * 选中的那几行留着高亮，要不要再写一行结果见 askAnswerText。
   */
  function settleAskCard(st, id, answer) {
    const rec = id ? st.askCards.get(id) : undefined;
    if (!rec || rec.done) { return; }
    rec.done = true;
    const el = rec.el;
    el.classList.add("done");
    el.querySelectorAll(".ask-foot, .ask-input").forEach((node) => { node.remove(); });
    rec.okBtn = null;
    rec.input = null;
    const picks = answer && Array.isArray(answer.picks) ? answer.picks : [];
    el.querySelectorAll(".ask-opt").forEach((b) => {
      if (picks.indexOf(b.dataset.opt || "") >= 0) { b.classList.add("picked"); }
    });
    const text = askAnswerText(rec, answer);
    if (text) {
      const line = document.createElement("div");
      line.className = "ask-answer";
      line.textContent = text;
      el.appendChild(line);
    }
    scrollToBottom(st);
  }

  /** 交答案：卡片先自己定住（等宿主那声 askCardDone 也行，但先定住免得让人点两下）。 */
  function submitAskCard(st, rec, answer) {
    if (rec.done) { return; }
    // 这一答是不是"人正拿着卡片那行输入框在打字"（决定下面要不要把光标放回输入框）：
    // 得在 settleAskCard 之前问——那一下就把卡片里那行输入框摘掉了。
    const typed = !!rec.input && document.activeElement === rec.input;
    settleAskCard(st, rec.id, answer);
    const msg = { type: "askCardAnswer", id: rec.id };
    if (Array.isArray(answer.picks)) { msg.picks = answer.picks; }
    if (typeof answer.text === "string") { msg.text = answer.text; }
    if (answer.yes !== undefined) { msg.yes = answer.yes; }
    if (answer.cancelled === true) { msg.cancelled = true; }
    vscode.postMessage(msg);
    // 打字答的那一种：光标放回下面那个输入框，答完接着就能打字。手机上也靠这一下把软键盘
    // 留住——那行输入框刚好被摘掉（settleAskCard），不主动放的话，手机浏览器会自己把光标
    // 挪到"下一个能输入的地方"（就是它，但是它自己挑的），电脑上则哪儿都不落。
    // 点选项 / 点按钮答的那一种不放：那种时候手机上键盘本来关着，放回去会把键盘惹出来。
    if (typed) { inputEl.focus(); }
  }

  /** 卡片底下的一颗小按钮（确定 / 取消 / 是 / 否）。 */
  function askButton(row, label, primary, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ask-btn" + (primary ? " primary" : "");
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    row.appendChild(btn);
    return btn;
  }

  /** 多选那种卡片上「确定」交回去的东西：勾中的几项 + "自己写"那一行写的。 */
  function askCardAnswer(rec) {
    const text = String(rec.input && rec.input.value || "").trim();
    const answer = { picks: rec.picked.slice() };
    if (text) { answer.text = text; }
    return answer;
  }

  /** 多选那颗粒「确定」能不能按：勾了东西、或者自己写了话，才让它按得下去。 */
  function syncAskFoot(rec) {
    if (!rec.okBtn) { return; }
    const text = String(rec.input && rec.input.value || "").trim();
    rec.okBtn.disabled = rec.picked.length === 0 && !text;
  }

  /** 这张卡片插在哪条工具行下面（还在的话）；找不到就接在当前内容末尾。 */
  function askCardAnchor(st, toolCallId) {
    if (typeof toolCallId !== "string" || !toolCallId) { return null; }
    const tag = st.pendingToolTags.get(toolCallId);
    if (tag && tag.parentElement) { return tag.parentElement; }
    const entry = st.toolGroupEntries.get(toolCallId);
    const groupTag = entry && entry.group ? entry.group.tag : null;
    return groupTag && groupTag.parentElement ? groupTag.parentElement : null;
  }

  /**
   * 问话卡片有时候比它那条工具行先到（工具调用走一条通道、问话暗号走 stderr 另一条，快慢不一定）：
   * 工具行一出来就把卡片挪到它下面（卡片本来就是"挂在这条调用下面"的东西）。
   */
  function dockAskCardToRow(st, toolCallId, row) {
    if (!toolCallId || !row || !st.askCards || st.askCards.size === 0) { return; }
    for (const rec of st.askCards.values()) {
      if (rec.toolCallId !== toolCallId) { continue; }
      if (rec.el.previousElementSibling === row) { return; }   // 已经在下边了
      row.after(rec.el);
      return;
    }
  }

  /** 画一张问话卡片（宿主发来的 askCard）。同一张卡片重发（整屏重画后补发 / 重连对账后补发）就换掉旧的。 */
  function renderAskCard(st, msg) {
    const id = String(msg && msg.id || "");
    if (!id) { return; }
    const card = msg.card && typeof msg.card === "object" ? msg.card : {};
    const kind = card.kind === "confirm" || card.kind === "prompt" ? card.kind : "choice";
    const cardJson = JSON.stringify(card);
    const old = st.askCards.get(id);
    if (old) {
      // 重连对账会把还等着的卡片重发一遍：这张已经在页面上、内容一个样，就别动它
      // （重建会把卡片里打了一半的字抹掉、把滚动位置抖一下）；人已经答过的那张也不动，
      // 免得答过的卡片又变回一张崭新的、要人重答的卡（答案还在送去宿主的路上）。
      if (old.done || old.cardJson === cardJson) { return; }
      old.el.remove();
    }
    hideEmptyHint(st);
    const rec = {
      id,
      kind,
      cardJson,
      multi: kind === "choice" && card.multi === true,
      toolCallId: typeof card.toolCallId === "string" ? card.toolCallId : "",
      picked: [],          // 多选勾中的那几项（按选项原文记）
      input: null,
      okBtn: null,
      el: null,
      done: false,
    };
    const el = document.createElement("div");
    el.className = "msg ask-card msg-enter";
    el.dataset.askId = id;
    rec.el = el;

    const title = document.createElement("div");
    title.className = "ask-title";
    title.textContent = String(
      kind === "choice" ? (card.question || "选一个") : (card.title || (kind === "confirm" ? "确认" : "请输入")),
    );
    el.appendChild(title);

    const foot = document.createElement("div");
    foot.className = "ask-foot";

    if (kind === "confirm") {
      const body = document.createElement("div");
      body.className = "ask-body";
      body.textContent = String(card.message || "");
      if (body.textContent) { el.appendChild(body); }
      askButton(foot, "是", true, () => submitAskCard(st, rec, { yes: true }));
      askButton(foot, "否", false, () => submitAskCard(st, rec, { yes: false }));
    } else if (kind === "prompt") {
      const input = document.createElement("input");
      input.className = "ask-input";
      input.type = "text";
      input.value = typeof card.prefill === "string" ? card.prefill : "";
      if (typeof card.placeholder === "string") { input.placeholder = card.placeholder; }
      // 手机键盘上那颗键写明是"回车"：不写，安卓上会把它当成"下一项" ——
      // 按下去只是把光标挪到下一个能输入的地方，这句话交不出去（"自己写"那行同一个道理）。
      input.setAttribute("enterkeyhint", "enter");
      // 回车 = 交答案（不是"发送"）：拦住别往上冒到输入框那层
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") { return; }
        e.preventDefault();
        e.stopPropagation();
        submitAskCard(st, rec, { text: input.value });
      });
      rec.input = input;
      el.appendChild(input);
      askButton(foot, "确定", true, () => submitAskCard(st, rec, { text: input.value }));
      askButton(foot, "取消", false, () => submitAskCard(st, rec, { cancelled: true }));
    } else {
      const list = document.createElement("div");
      list.className = "ask-opts";
      const options = Array.isArray(card.options) ? card.options : [];
      const recommended = Array.isArray(card.recommended) ? card.recommended : [];
      options.forEach((raw, index) => {
        const label = String(raw);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ask-opt";
        btn.dataset.opt = label;
        const text = document.createElement("span");
        text.className = "ask-opt-text";
        text.textContent = label;
        btn.appendChild(text);
        if (recommended.indexOf(index + 1) >= 0) {
          const badge = document.createElement("span");
          badge.className = "ask-rec";
          badge.textContent = "我推荐";
          btn.appendChild(badge);
        }
        btn.addEventListener("click", () => {
          if (rec.done) { return; }
          // 单选：点一行就是答案；多选：点一下勾上 / 再点取消，勾完按底下的「确定」
          if (!rec.multi) { submitAskCard(st, rec, { picks: [label] }); return; }
          const at = rec.picked.indexOf(label);
          if (at >= 0) { rec.picked.splice(at, 1); } else { rec.picked.push(label); }
          btn.classList.toggle("on", at < 0);
          syncAskFoot(rec);
        });
        list.appendChild(btn);
      });
      el.appendChild(list);

      // "自己写"那一行：选项里都不合适时用（ask_choice 默认给，扩展问的"选一个"不给）
      if (card.allowText !== false) {
        const input = document.createElement("input");
        input.className = "ask-input";
        input.type = "text";
        input.placeholder = "或者自己写…";
        // 手机键盘上那颗键写明是"回车"：不写，安卓上会把它当成"下一项" ——
        // 按下去只是把光标挪到下一个能输入的地方（就是下面那个大输入框），答案交不出去。
        input.setAttribute("enterkeyhint", "enter");
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") { return; }
          e.preventDefault();
          e.stopPropagation();
          submitAskCard(st, rec, askCardAnswer(rec));
        });
        input.addEventListener("input", () => { syncAskFoot(rec); });
        rec.input = input;
        el.appendChild(input);
      }
      // 多选：勾完得按一下「确定」（单选不用：点一行就是答案，"自己写"那行里按回车交回去）
      if (rec.multi) {
        rec.okBtn = askButton(foot, "确定", true, () => submitAskCard(st, rec, askCardAnswer(rec)));
      }
    }
    // 底下那一行：单选与确认卡片都没有（答案就在上面那几行里），只有多选与输入留一颗按钮
    if (foot.childElementCount > 0) { el.appendChild(foot); }
    if (kind === "choice") { syncAskFoot(rec); }

    const anchor = askCardAnchor(st, card.toolCallId);
    if (anchor) { anchor.after(el); } else { st.paneEl.appendChild(el); }
    // 卡片算一道坎：后面的工具标签另起一行（画在卡片下面，不往上面那条工具行里钻）
    st.currentToolRow = null;
    endRunningLine(st);   // 同上：这批工具过去了，还在留的那条位置也收掉
    st.askCards.set(id, rec);
    scrollToBottom(st);
  }

  // ==================== 通用拾取器浮层（模型 / 历史）====================

  /** 收掉一块面板、把它那份状态清干净（哪一块由 view 指定，默认是浮层那份）。 */
  function hidePicker(view = modalView) {
    // 常驻那一列的几颗类写在 HTML 里（staticChrome），收起时不摘：它下次展开还要用同一套版式
    if (!view.staticChrome) {
      view.root.classList.add("hidden");
      view.root.classList.remove("pk-drawer");
      view.root.classList.remove("pk-workspace");
      view.root.classList.remove("pk-folders");
    }
    view.body.innerHTML = "";
    if (view.search) { view.search.value = ""; }
    setPickerSubtitle("", view);
    view.footer.innerHTML = "";
    view.footer.classList.add("hidden");
    view.footer.classList.remove("pk-model-footer");
    view.footer.classList.remove("pk-history-footer");
    const leftoverClose = view.root.querySelector(".pk-header-close");
    if (leftoverClose) { leftoverClose.remove(); }
    if (view.searchWrap) { view.searchWrap.classList.remove("hidden"); }
    // “关闭会话”的确认条只在列表里有效：列表一关就撤销（下次打开不要停在确认态）
    if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
    pendingCloseTimer = null;
    pendingCloseId = null;
    view.state = null;
    view.openSessionsShown = "";
    // 那两格跟着面板一起没了（重开时由 renderPickerItems 重建）：别留着指已经拆掉的格子
    view.sessionPane = null;
    view.spacePane = null;
    view.spaceRowsShown = "";
  }

  // ==================== 常驻的项目与会话侧边栏（宽窗下右边那一列）====================
  //
  // 窗口够宽时（跟限宽那一列同一道 900px 门槛）「项目与会话」不当浮层：它贴右边占一列，
  // 对话让出这块宽度（版面见 chat.css 末尾那段）。收没收起记在这台设备里，默认展开；
  // 窗口窄（手机、窄面板）一点都不变：还是从右边滑进来、点外面收起来。
  //
  // 这一列画在自己的容器（#sidebarDock）里，跟浮层那一摊各画各的：中途开一次选模型、
  // 逛文件夹那种浮层时它照样在原处（浮层盖在上面而已），内容不丢、宽度也不跳。
  // 画法与版式都共用（下面这些渲染函数都认 view，类名也是同一套），看着跟滑进来的那张抽屉一样。
  //
  // 顶条那颗 <<< 由 browserBridge.js 建，点它叫这里的 toggleSidebar（它加载在 chat.js 之前，
  // 所以走这个全局接口；没装成也不报错：接口不在就退回老行为）。
  const SIDEBAR_MIN_WIDTH = 900;
  const SIDEBAR_STORE_KEY = "pichat.sidebarOpen";
  /** 这一屏要不要把项目与会话侧边栏常驻着（记在本机里；没记过 = 要）。 */
  let sidebarWanted = readSidebarWanted();
  /** 已经跟宿主开口要过了（内容没回来之前别连着再要一遍）。 */
  let sidebarAsked = false;

  function readSidebarWanted() {
    try { return localStorage.getItem(SIDEBAR_STORE_KEY) !== "0"; } catch (e) { return true; }
  }
  function rememberSidebarWanted(want) {
    try { localStorage.setItem(SIDEBAR_STORE_KEY, want ? "1" : "0"); } catch (e) { /* 存不了就只管这一次 */ }
  }
  /** 窗口够宽吗（不够就走浮层那一套）。 */
  function sidebarWide() { return window.innerWidth >= SIDEBAR_MIN_WIDTH; }
  /** 窗口够宽、而且用户没收起：右边那一列开着吗（留不留那一列、面板显不显示都看它）。 */
  function sidebarEnabled() { return sidebarWanted && sidebarWide(); }
  /** 右边那一列里正画着面板吗。 */
  function sidebarDocked() { return !!dockView.state; }
  /** 有没有浮层正占着屏幕（常驻那一列不算：它不遮对话，Esc / 方向键也不归它）。 */
  function pickerModalOpen() {
    return !!modalView.state && !modalView.root.classList.contains("hidden");
  }

  /** 按“要不要常驻”摆版面：宽窗且没收起时，右边留出那一列（CSS 看 body.dock-sidebar）。 */
  function syncSidebarLayout() {
    const on = sidebarEnabled();
    document.body.classList.toggle("dock-sidebar", on);
    const btn = document.getElementById("browserMenuBtn");
    // 常驻开着时这颗按钮的意思是“收起”，提示语跟着换
    if (btn) { btn.title = on ? "收起侧边栏" : "项目与会话"; }
    syncDockHeaderHeight();
    syncDockFooterHeight();
  }

  /**
   * 常驻那一列的面板头跟对话那边的顶条对齐：两根横线（顶条的底边、面板头的底边）落在
   * 同一条线上，而且要落在整像素上（不取整那条线会压在半个像素上，看着发虚）。
   * 顶条的高度是跟内容走的（会话名 + 目录两行、字号设置、面板宽度），所以量出来向上取整，
   * 两边写同一个数；量之前先把上一回写死的高度摘掉，量到的才是它本来的高度。
   * 左边那一列（文件侧边栏）常驻时也拿同一个数：三根横线齐。
   * 老白量一次不好（会多搭一次重排）：顶条的高度只跟字号 / 目录那行有没有 / 面板宽度有关，
   * 这几样没变就直接回来。 */
  let dockBarKey = "";
  function syncDockHeaderHeight() {
    const bar = document.getElementById("sessionBar");
    if (!bar) { return; }
    const rightDock = sidebarEnabled();
    const fileDock = fileSidebarDocked();
    const fileHeader = fileSidebar.header;
    if (!rightDock && !fileDock) {
      // 都没常驻（窄窗、插件面板）：顶条回到自己按内容定高，别留着上一回写死的值
      if (bar.style.height || dockView.header.style.height || (fileHeader && fileHeader.style.height)) {
        bar.style.height = "";
        dockView.header.style.height = "";
        if (fileHeader) { fileHeader.style.height = ""; }
        dockBarKey = "";
      }
      return;
    }
    const pathShown = !!(sessionPathEl && !sessionPathEl.classList.contains("hidden"));
    // 左边那一列的宽度也算进键里：对话那边一变宽窄，顶条里的名字 / 目录可能多折一行、高度就变了
    //（拖宽度拖完定下来的那一下会调到这里，见 wireFileSidebarResize）。
    const key = (document.body.style.getPropertyValue("--vscode-font-size") || "") + "|" +
      (pathShown ? "dir" : "") + "|" + window.innerWidth + "|" +
      (rightDock ? "r" : "") + (fileDock ? "l" + Math.round(fileSidebar.width) + "|" : "");
    if (key === dockBarKey) { return; }
    bar.style.height = "";
    const h = Math.ceil(bar.getBoundingClientRect().height);
    bar.style.height = h + "px";
    if (rightDock) { dockView.header.style.height = h + "px"; }
    if (fileDock && fileHeader) {
      // 这一列的头可能写着两行（会话目录 + 现在走到的这一层）：顶条那点高不够时以这一列自己的内容为准
      //（不然第二行就被压掉了）。头上一行的时候两边照样齐（见 setFileSidebarTitle）。
      fileHeader.style.height = "";
      const own = Math.ceil(fileHeader.getBoundingClientRect().height);
      fileHeader.style.height = Math.max(h, own) + "px";
    }
    dockBarKey = key;
  }

  /**
   * 常驻那一列底部的「设置」那块跟对话那边的输入区同高：这一块的上边线、输入区的上边线
   * 落在同一条线上（跟上面面板头那两根顶线一个道理）。
   * 输入区的高度是跟内容走的（输入框长高一行、贴了附件、排队的消息多一条都会变），所以不写死，
   * 每回现量：“从输入区上边线量到这一列的底边”，量出来多高就把它多高。
   * 直接量两个边、不要各自取整再相减：那样两条线会错开半个像素，看着发虚。
   * 那块高起来的时候，里头的按钮贴着底边（见 chat.css 的 #dockFooter）：线往上走，按钮不动。 */
  let dockFooterH = 0;
  function syncDockFooterHeight() {
    const foot = dockView.footer;
    const area = document.getElementById("inputArea");
    const panel = document.getElementById("dockPanel");
    if (!foot || !area || !panel) { return; }
    if (!sidebarEnabled()) {
      // 没常驻（窄窗、插件面板，或者收起来了）：这一列不在屏上，别留着上一回写死的高度
      if (foot.style.height) { foot.style.height = ""; }
      dockFooterH = 0;
      return;
    }
    const pane = panel.getBoundingClientRect();
    // 这一列还没显出来（刚展开、内容还在路上）：这会儿量出来的是 0，等画出来那一次再量
    if (!pane.height) { return; }
    const h = Math.round(pane.bottom - area.getBoundingClientRect().top);
    if (h === dockFooterH) { return; }
    dockFooterH = h;
    foot.style.height = Math.max(0, h) + "px";
  }

  // 输入区的高度自己会变（打字打长、贴附件、排队的消息）：变一次就对一次，不等窗口 resize。
  // 上面那个函数里量的是输入区的上边线，所以只盯它就够。
  if (typeof ResizeObserver === "function") {
    const inputArea = document.getElementById("inputArea");
    if (inputArea) { new ResizeObserver(() => syncDockFooterHeight()).observe(inputArea); }
  }

  /** 右边那一列该有内容、而现在没画着：跟宿主再要一份（列先空着，不闪不跳）。 */
  function ensureSidebarPanel() {
    if (!sidebarEnabled() || sidebarDocked() || sidebarAsked) { return; }
    sidebarAsked = true;
    vscode.postMessage({ type: "openWorkspace", dock: true });
    // 万一这条消息丢了（刚重连上那一阵、宿主那头正开着别的浮层）：过几秒放行，下一回再要
    setTimeout(() => { sidebarAsked = false; }, 5000);
  }

  /** 展开常驻那一列（点 <<< 或面板里那颗叉的对面那种情形），并把“展开”记住。 */
  function expandSidebar() {
    // 窄窗里这一列与左边那一列同一时刻只留一块：先把左边收起来
    closeFileSidebarForRightSidebar();
    sidebarWanted = true;
    rememberSidebarWanted(true);
    sidebarAsked = false;
    syncSidebarLayout();
    ensureSidebarPanel();
  }

  /** 收起常驻那一列：面板收掉，并把“收起”记住（下次打开还是收起）。 */
  function collapseSidebar() {
    sidebarWanted = false;
    sidebarAsked = false;
    rememberSidebarWanted(false);
    syncSidebarLayout();
    if (sidebarDocked()) { hidePicker(dockView); }
  }

  /** 顶条那颗 <<< ：宽窗是常驻的收起 / 展开，窄窗照旧弹一次抽屉。 */
  function toggleSidebar() {
    if (!sidebarWide()) {
      // 窄窗：开了就收、没开就滑进来。开这一次不改变“宽窗要不要常驻”那个记忆。
      const st = modalView.state;
      if (st && st.kind === "workspace" && !modalView.root.classList.contains("hidden")) { cancelPicker(modalView); return; }
      // 两边同一时刻只开一块：左边那块开着就先收起来
      closeFileSidebarForRightSidebar();
      vscode.postMessage({ type: "openWorkspace" });
      return;
    }
    if (sidebarEnabled() && sidebarDocked()) { collapseSidebar(); } else { expandSidebar(); }
  }

  // 换窗口宽窄（拖边、转手机屏幕）：跨过那道门槛时把版面与面板跟着换过来
  let sidebarResizeFrame = 0;
  window.addEventListener("resize", () => {
    if (sidebarResizeFrame) { return; }
    sidebarResizeFrame = requestAnimationFrame(() => {
      sidebarResizeFrame = 0;
      const wasDocked = sidebarDocked();
      syncSidebarLayout();
      if (!sidebarWide()) {
        // 变窄了：常驻那一列装不下，把面板收掉（记忆不动：拉宽回来还会自己起来）
        sidebarAsked = false;
        if (wasDocked) { hidePicker(dockView); }
        return;
      }
      ensureSidebarPanel();
    });
  });

  // ==================== 文件侧边栏（只在浏览器页面里）====================
  //
  // 点消息流里的文件链接，左边开出一列，只读地显示那个文件：带行号，停在链接说的那一行并高亮。
  // 内容由后端那条只读的文件地址（/file）按当前会话的目录读出来，不经过编辑器——手机上、
  // 或者只跑了后端没开编辑器的时候，点链接才有着落（见 docs/adr/0001-浏览器页面自己读文件.md）。
  //
  // 只有浏览器页面里有它：插件里的对话面板里点链接照旧交给编辑器打开。判据就是上面那个
  // IN_WEBVIEW 标记（界面桥放在 window 上的，跟顶条上那颗桌面截图按钮同一路）。
  //
  // 看过的文件在这一列头上排成一排标签：再点别的文件就多一个标签、原来那个还留着；点一个
  // 已经开着的文件就切回它那个标签、按这次链接说的行滚过去（同一个文件只留一个标签）；
  // 标签上那颗叉把它关掉；全关光后这一列不收起，留一句提示。标签只在这一趟页面上记着，
  // 刷新就没了（开没收起是记在这台设备里的，那个留着）。
  //
  // 第一个标签是「项目目录」（当前会话的目录）：点链接看的文件排在它后面的新标签里，不顶掉它。
  // 它没有那颗叉（关不掉），一直在最前面；列那一格走的是票 05 那套（同一条 `/dir` 地址，
  // `.` 表示会话目录自己）。
  //
  // 目录不占标签：点消息流里的目录链接、点清单里的子目录，都在「项目目录」这一格里换内容
  //（切到那一格、把这一层列出来），往回的「上一层」是清单里的第一行——到会话目录本身那一层就没有
  // 这一行了（不许走到会话目录外面去）。标签上一直写「项目目录」，现在在哪一层看这一列的头
  //（上面一行会话目录、下面一行现在走到的这一层；悬停提示里给的是这一层的全路径）。
  // 切会话、刷新页面时这一格回到会话目录本身（不记住走到哪一层）。
  //
  // 正看着的那个文件被改了（模型改的、脚本改的）以后，内容自己换成新的，而人读到哪儿还停在哪儿：
  // 隔一会儿问一次那个文件变了没，问的时候把上次拿到的修改时间带上——没变后端只回一个空响应，
  // 变了才把正文取回来重画，重画时把现在的滚动位置照原样放回去。
  //
  // 显示成什么看后端那条地址怎么回：文本画成带行号的正文；图片直接显示那张图（拿这条地址的
  // 回应当图片源）；二进制和超过 2 MB 的不把内容塞进页面，只给一句说明加一个下载。那条带
  // download=1 的地址不设大小上限，几 MB 的文件也下得下来。
  //
  // 窗口够宽（≥1200px）时这一列常驻在左边、对话让出这块宽度；窄了从左边滑入、点外面收起。
  // 手机上同一时刻只开一块侧边栏：开左边这块就把右边那块收起来，反过来也一样
  //（两块都常驻时不受这条约束）。开没收起记在这台设备里（跟右边那一列同一个做法）。
  const FILE_SIDEBAR_MIN_WIDTH = 1200;
  /**
   * 这一列拖起来能有多窄多宽（两边都封死；为什么是这两个数、为什么不给拖到无限宽，
   * 见 docs/adr/0002-文件侧边栏宽度能拖.md）。常驻时还要再跟「窗口宽度 − FILE_SIDEBAR_W_RESERVE」
   * 取小，保证对话那边留得住（见 clampFileSidebarWidth）。
   */
  const FILE_SIDEBAR_W_MIN = 300;
  const FILE_SIDEBAR_W_MAX = 1200;
  /** 没拖过时这一列多宽（原来写死在 chat.css 里的那个 320px，默认值现在挪到这儿）。 */
  const FILE_SIDEBAR_W_DEFAULT = 360;
  const FILE_SIDEBAR_W_RESERVE = 360;
  /** 跟着刷新：每隔这么久问一次现在看着的那个文件变了没（问法见 pollActiveFile）。 */
  const FILE_SIDEBAR_POLL_MS = 1500;
  /**
   * 上色那条线：正文不超过这么多字符才上色，超过就黑白、只带行号（见 highlightFileLines）。
   * 整段高亮是一次同步调用，几十万字符就要几百毫秒，而这里一列正文可以到 2 MB——
   * 不给它设个上限，点开一个大文件就把页面卡在那儿了。
   */
  const FILE_HIGHLIGHT_MAX_CHARS = 384 * 1024;
  const FILE_SIDEBAR_STORE_KEY = "pichat.fileSidebarOpen";
  /** 拖出来的宽度（像素数）：跟收没收起一样记在这台设备里。 */
  const FILE_SIDEBAR_WIDTH_STORE_KEY = "pichat.fileSidebarWidth";
  /** 长行怎么摆（折起来 / 一行就是一行）：也记在这台设备里（跟收没收起同一个做法）。 */
  const FILE_SIDEBAR_WRAP_STORE_KEY = "pichat.fileSidebarWrap";
  const FILE_SIDEBAR_HINT = "点消息里的文件链接，这里会显示那个文件。";
  /** 「项目目录」那一格：标签上写这四个字，悬停提示给这一层的全路径（见 fileSidebarProjectFullPath）。 */
  const FILE_SIDEBAR_PROJECT_NAME = "项目目录";
  /** 问后端「会话目录自己」用这个相对写法（列目录那条地址不认空路径，`.` 就是会话目录）。 */
  const FILE_SIDEBAR_PROJECT_PATH = ".";
  /** 这一列那一摊：容器、里面那几块、开着哪几个文件。 */
  const fileSidebar = {
    root: null, header: null, title: null, tabsEl: null, body: null, resize: null,
    open: false,     // 这台设备上人要不要它开着（记在 localStorage；开着时宽窗常驻、窄窗滑入）
    // 人拖出来的宽度（像素数，也记在本机里）：没拖过就是 FILE_SIDEBAR_W_DEFAULT。
    // 写到版式上的那个值还可能被窗口收小，但这里留着的永远是原值（见 applyFileSidebarWidth）。
    width: 0,
    // 开着的文件（从左到右）与「项目目录」那一格：[{ path, proj, line, scrollTop, mtime, loading, imageUrl }]
    wrap: false,     // 长行折起来还是横向滚（记在 localStorage；默认一行就是一行，见 chat.css 末尾）
    // 开着的文件与目录，从左到右：[{ path, dir, line, scrollTop, mtime, loading, imageUrl }]
    //（不记进设备，刷新就没了）
    //   path：文件是链接里那个写法；「项目目录」那一格是它现在待的那一层
    //（相对会话目录的写法：`.` 就是会话目录自己）
    //   proj：这是「项目目录」那一格（排在最前、没有关闭那颗叉）：它列出来的是一份清单，
    //   所有进目录 / 换目录的事都在它里面发生；不是它就是某个文件
    //   mtime：画在这一列上的那份内容的修改时间（下次问「变了没」时带上去）
    //   loading：还在取（正文那块写着「正在读取…」）
    //   imageUrl：图片那个显示地址（blob:…）；换成别的图或关掉标签时要放掉它
    tabs: [],
    active: -1,      // 现在看的是哪一个标签（下标）；一个都没开就是 -1
    token: 0,        // 取文件是异步的：换标签 / 收起之后回来的旧回应就不算数了
  };
  /** 上一条「变了没」的询问还在路上（手机网慢）：这一轮先不发，别越堆越多。 */
  let filePolling = false;

  /** 窗口够宽吗（够宽这一列常驻，不够就是滑入式）。 */
  function fileSidebarWide() { return window.innerWidth >= FILE_SIDEBAR_MIN_WIDTH; }
  /** 这一列此刻常驻在左边吗。 */
  function fileSidebarDocked() { return fileSidebar.open && fileSidebarWide(); }

  /**
   * 把宽度夹回能用的范围：先夹在 300～1200 之间；常驻时再跟「窗口宽度 − 360」取小
   *（滑入和铺满本来就盖在对话上，不受后面那条管，所以 reserveForChat 传 false 就跳过它）。
   */
  function clampFileSidebarWidth(px, reserveForChat) {
    const room = reserveForChat ? window.innerWidth - FILE_SIDEBAR_W_RESERVE : FILE_SIDEBAR_W_MAX;
    const cap = Math.max(FILE_SIDEBAR_W_MIN, Math.min(FILE_SIDEBAR_W_MAX, room));
    return Math.max(FILE_SIDEBAR_W_MIN, Math.min(px, cap));
  }
  /**
   * 人拖出来的那个宽度。只夹 300～1200，不按窗口收：窗口大小变了不该把人家存的值改掉
   *（窗口一变，常驻时那个上限跟着变，那是写到版式上时才算的）。
   */
  function readFileSidebarWidthWanted() {
    let n = NaN;
    try { n = parseInt(localStorage.getItem(FILE_SIDEBAR_WIDTH_STORE_KEY), 10); } catch (e) { /* 读不了就用默认值 */ }
    return clampFileSidebarWidth(Number.isFinite(n) ? n : FILE_SIDEBAR_W_DEFAULT, false);
  }
  function rememberFileSidebarWidth(px) {
    try { localStorage.setItem(FILE_SIDEBAR_WIDTH_STORE_KEY, String(Math.round(px))); } catch (e) { /* 存不了就只管这一次 */ }
  }
  /**
   * 把宽度写到版式上（CSS 变量 --pichat-file-sidebar-w，见 chat.css 那一大段）。
   * 每次摆版面都重写一遍：常驻时那个「对话留 360」的上限是跟窗口宽度走的，窗口一变就得重算。
   * 写进去的可能是被窗口收小的值，但 fileSidebar.width 里留的是人拖出来的原值：
   * 窗口拉回来，这一列自己就回到他拖的那个数。
   */
  function applyFileSidebarWidth() {
    const w = clampFileSidebarWidth(fileSidebar.width, fileSidebarDocked());
    document.documentElement.style.setProperty("--pichat-file-sidebar-w", w + "px");
  }

  /** 按“开没收起、常驻还是滑入、长行折还是滚”摆版面（版式看 body 上的 file-open / file-dock / file-wrap，见 chat.css 末尾）。 */
  function syncFileSidebarLayout() {
    document.body.classList.toggle("file-open", fileSidebar.open);
    const docked = fileSidebarDocked();
    document.body.classList.toggle("file-dock", docked);
    document.body.classList.toggle("file-wrap", fileSidebar.wrap);
    // 触屏（手机 / 平板）上滑入的那一层铺满整屏（见 chat.css 的 body.file-full）：
    // 底下那层遮罩整个被盖住，「点外面收起」在那条路上就没了，收起看头上那颗叉。
    document.body.classList.toggle("file-full", fileSidebar.open && !docked && IS_TOUCH_DEVICE);
    applyFileSidebarWidth();
    const btn = document.getElementById("fileSidebarBtn");
    if (btn) { btn.title = fileSidebar.open ? "收起文件侧边栏" : "文件侧边栏"; }
    const wrapBtn = document.getElementById("fileWrap");
    if (wrapBtn) {
      // 角上那颗开关点下去要做什么就在悬停提示里说清楚，按下去的样子（.on）表示现在是折行的。
      wrapBtn.title = fileSidebar.wrap ? "长行折起来了，点一下改成一行就是一行" : "一行就是一行，点一下把长行折起来";
      wrapBtn.setAttribute("aria-pressed", fileSidebar.wrap ? "true" : "false");
      wrapBtn.classList.toggle("on", fileSidebar.wrap);
    }
    syncDockHeaderHeight();
  }
  function rememberFileSidebar(open) {
    try { localStorage.setItem(FILE_SIDEBAR_STORE_KEY, open ? "1" : "0"); } catch (e) { /* 存不了就只管这一次 */ }
  }
  function readFileSidebarWanted() {
    try { return localStorage.getItem(FILE_SIDEBAR_STORE_KEY) === "1"; } catch (e) { return false; }
  }
  function rememberFileSidebarWrap(wrap) {
    try { localStorage.setItem(FILE_SIDEBAR_WRAP_STORE_KEY, wrap ? "1" : "0"); } catch (e) { /* 存不了就只管这一次 */ }
  }
  /** 没记过时是一行就是一行（跟这一列本来的摆法一致）。 */
  function readFileSidebarWrapWanted() {
    try { return localStorage.getItem(FILE_SIDEBAR_WRAP_STORE_KEY) === "1"; } catch (e) { return false; }
  }

  /** 路径在界面上的写法：目录带一个末尾斜杠，一眼看出它不是文件。 */
  function pathLabel(path, dir) { return dir ? path + "/" : path; }

  /**
   * 「项目目录」那一格头上那几行字：上面一行是会话目录本身（这一格的最外面那一层），
   * 下面一行是现在走到的这一层（在会话目录里面的走法，`dirA/sub`）——不把两段拼成一长条。
   * 还在最外面那一层就只有上面那一行；会话目录还没认识就写那四个字。
   */
  function fileSidebarProjectTitleLines(tab) {
    const base = activeSessionCwd();
    if (!base) { return [FILE_SIDEBAR_PROJECT_NAME]; }
    const inside = tab.path === FILE_SIDEBAR_PROJECT_PATH ? "" : String(tab.path);
    return inside ? [base, inside] : [base];
  }

  /**
   * 「项目目录」那一格现在这一层的全路径（`.` 那一层就是会话目录本身）：
   * 标签的悬停提示与头上那几行字的悬停提示写它。
   */
  function fileSidebarProjectFullPath(tab) {
    const base = activeSessionCwd();
    if (!base) { return FILE_SIDEBAR_PROJECT_NAME; }
    if (tab.path === FILE_SIDEBAR_PROJECT_PATH) { return base; }
    const sep = base.indexOf("\\") >= 0 ? "\\" : "/";
    return base.replace(/[\\/]+$/, "") + sep + String(tab.path).replace(/\//g, sep);
  }

  /** 一格标签悬停提示上的全路径：项目目录那一格是它现在待的那一层（头上的字见 setFileSidebarTitle）。 */
  function fileSidebarTabFullPath(tab) {
    return tab.proj ? fileSidebarProjectFullPath(tab) : tab.path;
  }

  /** 标签上那行字：文件名。全路径太长，标签上停一下有提示、这一列头上写着会话目录与这一层。 */
  function fileSidebarTabName(path) {
    return String(path).replace(/\\/g, "/").split("/").pop() || String(path);
  }

  /** 这个文件已经开着了是哪一个标签（没开就是 -1）：同一个文件只留一个标签（目录不占标签）。 */
  function fileSidebarTabIndex(path) {
    for (let i = 0; i < fileSidebar.tabs.length; i++) {
      if (!fileSidebar.tabs[i].proj && fileSidebar.tabs[i].path === path) { return i; }
    }
    return -1;
  }

  /** 「项目目录」那一格在标签条上的下标（没有就是 -1）。 */
  function fileSidebarProjectIndex() {
    for (let i = 0; i < fileSidebar.tabs.length; i++) { if (fileSidebar.tabs[i].proj) { return i; } }
    return -1;
  }

  /** 摆一格新标签要的那些字段：一个文件，或者「项目目录」那一格（它列出来的是一份清单）。 */
  function fileSidebarNewTab(path, proj) {
    return { path: path, proj: !!proj, line: 0, scrollTop: 0, mtime: "", loading: false, imageUrl: "" };
  }

  /**
   * 把「项目目录」那一格摆到标签条最前面（只摆、不取内容）：这一列里没有它的时候摆。
   * 会话目录还不认识（会话列表还没到）就先不摆，等它到了再来（见 setFileSidebarOpen 与 sessionList 那段）。
   * @returns 摆了没有
   */
  function addProjectDirTab() {
    if (!fileSidebar.root || fileSidebarProjectIndex() >= 0) { return false; }
    if (!activeSessionCwd()) { return false; }
    fileSidebar.tabs.unshift(fileSidebarNewTab(FILE_SIDEBAR_PROJECT_PATH, true));
    if (fileSidebar.active >= 0) { fileSidebar.active++; }   // 挪下标：正看着的那一格不变
    return true;
  }

  /**
   * 这一列开着又空着（一个标签都没有）的时候，摆上「项目目录」那一格并显示它：
   * 刚打开、切会话、刷新页面走的都是这里；会话目录还没认识就留一句提示。
   */
  function ensureProjectDirTab() {
    if (!fileSidebar.root || !fileSidebar.open || fileSidebar.active >= 0) { return; }
    if (addProjectDirTab()) { showFileTab(0, 0); return; }
    showFileNote(FILE_SIDEBAR_HINT);
  }

  /**
   * 这一列头上那几行字：文件就一行（那个文件的写法）；「项目目录」那一格上面一行是会话目录、
   * 下面一行是现在走到的这一层（见 fileSidebarProjectTitleLines）；一个标签都没开就写「文件」。
   * @param tab 现在看着的那一格；没有（一个都没开）就给 null
   */
  function setFileSidebarTitle(tab) {
    const el = fileSidebar.title;
    if (!el) { return; }
    const lines = !tab ? ["文件"] : (tab.proj ? fileSidebarProjectTitleLines(tab) : [tab.path]);
    el.innerHTML = "";
    lines.forEach((text, i) => {
      const line = document.createElement("span");
      line.className = "file-title-line" + (i > 0 ? " file-title-in" : "");
      line.textContent = text;
      el.appendChild(line);
    });
    el.title = tab ? fileSidebarTabFullPath(tab) : "";   // 悬停给这一层的全路径（能整条选走）
    dockBarKey = "";   // 头上几行变了：常驻时这一列的头多高要重算（见 syncDockHeaderHeight）
    syncDockHeaderHeight();
  }

  /** 把现在这一格读到哪儿记进它那个标签（切走、重画之前）。 */
  function rememberFileTabScroll() {
    const tab = fileSidebar.tabs[fileSidebar.active];
    if (tab && fileSidebar.body) { tab.scrollTop = fileSidebar.body.scrollTop; }
  }

  /** 按现在开着的那几个文件重画标签条：点名字切过去、点那颗叉关掉。 */
  function renderFileTabs() {
    const bar = fileSidebar.tabsEl;
    if (!bar) { return; }
    bar.innerHTML = "";
    fileSidebar.tabs.forEach((tab, i) => {
      const el = document.createElement("div");
      el.className = "file-tab" + (i === fileSidebar.active ? " active" : "");
      el.setAttribute("data-path", tab.path);
      if (tab.proj) { el.setAttribute("data-proj", "1"); }
      el.title = fileSidebarTabFullPath(tab);   // 项目目录那一格悬停给现在这一层的全路径
      const name = document.createElement("span");
      name.className = "file-tab-name";
      name.textContent = tab.proj ? FILE_SIDEBAR_PROJECT_NAME : fileSidebarTabName(tab.path);
      el.appendChild(name);
      // 「项目目录」那一格没有那颗叉：它是这一列的第一格，不让人关掉（切会话 / 刷新页面时换成当前会话的）
      if (!tab.proj) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "file-tab-close";
        close.title = "关掉这个标签";
        close.setAttribute("aria-label", "关掉 " + tab.path);
        close.innerHTML = ICONS["close-bold"];
        close.addEventListener("click", (e) => { e.stopPropagation(); closeFileTab(i); });
        el.appendChild(close);
      }
      el.addEventListener("click", () => showFileTab(i, 0));
      bar.appendChild(el);
    });
    // 开着的标签多了会往右跑出这一列：把现在这个带进来看得见的地方
    const active = bar.querySelector(".file-tab.active");
    if (active) { active.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  }

  /**
   * 摆上某一个标签：这一列的头、标签条、正文都跟着换。
   * @param index 哪一个标签
   * @param hitLine 这次链接说的那一行（1 起）；0 = 没有要停的行，回这个标签上次读到的地方
   */
  function showFileTab(index, hitLine) {
    const tab = fileSidebar.tabs[index];
    if (!tab || !fileSidebar.body) { return; }
    rememberFileTabScroll();
    fileSidebar.active = index;
    const linkLine = Number(hitLine) > 0 ? Number(hitLine) : 0;
    if (linkLine > 0) { tab.line = linkLine; }
    setFileSidebarTitle(tab);
    renderFileTabs();
    showFileNote("正在读取…");
    loadIntoSidebar(linkLine);
  }

  /** 点标签上那颗叉：关掉这一个。全关光后这一列不收起，留一句提示。 */
  function closeFileTab(index) {
    if (!fileSidebar.tabs[index]) { return; }
    const wasActive = index === fileSidebar.active;
    releaseTabImage(fileSidebar.tabs[index]);
    fileSidebar.tabs.splice(index, 1);
    if (!wasActive) {
      // 关的不是正看着的这个：画面不动，只把标签条重画一遍（后面的下标要跟着挪）
      if (index < fileSidebar.active) { fileSidebar.active--; }
      renderFileTabs();
      return;
    }
    // 关掉的正是看着的这个：它已经不是哪一个标签了，手上还等着的那条回应也别再画进来
    fileSidebar.active = -1;
    fileSidebar.token++;
    if (fileSidebar.tabs.length === 0) {
      setFileSidebarTitle(null);
      renderFileTabs();
      showFileNote(FILE_SIDEBAR_HINT);
      return;
    }
    // 摆上右边那一个（关的是最后一个标签就摆上现在最后那一个）
    showFileTab(Math.min(index, fileSidebar.tabs.length - 1), 0);
  }

  /**
   * 这一列里那一段纯粹的文字（提示、看不了的原因、正在读取）；看不了但能下载时一并放上链接。
   * 已经就是这一句（连同同一个下载地址）就别再重画：跟着刷新每轮都会来报「还是看不了」，
   * 而人可能正选着里面的字。
   * @param download 给了就在句末跟一颗下载链接：{ url, name, label }
   */
  function showFileNote(text, download) {
    if (!fileSidebar.body) { return; }
    const href = download ? download.url : "";
    const only = fileSidebar.body.children.length === 1 ? fileSidebar.body.firstElementChild : null;
    const oldText = only && only.firstElementChild ? only.firstElementChild.textContent : null;
    const oldLink = only && only.querySelector ? only.querySelector("a.file-download") : null;
    if (only && only.className === "file-note" && oldText === text
        && ((!oldLink && !href) || (oldLink && oldLink.getAttribute("href") === href))) {
      return;
    }
    fileSidebar.body.innerHTML = "";
    const note = document.createElement("div");
    note.className = "file-note";
    const line = document.createElement("span");
    line.textContent = text;
    note.appendChild(line);
    if (href) {
      const link = document.createElement("a");
      link.className = "file-download";
      link.href = href;
      link.setAttribute("download", download.name || "");
      link.textContent = download.label || "下载";
      note.appendChild(document.createTextNode(" "));
      note.appendChild(link);
    }
    fileSidebar.body.appendChild(note);
    prependFileUpRow();
  }

  /**
   * 清单第一行那颗「上一层」：「项目目录」那一格待在某一层子目录里、而且正看着它的时候才有这一行
   *（`.` 就是会话目录本身，到那一层就没有再往上的了——不许走到会话目录外面去）。
   * 它长在清单里（第一行），不在这一列头上那颗「收起」旁边。
   * @returns 这一行；不该有的时候给 null
   */
  function buildFileUpRow(tab) {
    if (!tab || !tab.proj || tab.path === FILE_SIDEBAR_PROJECT_PATH) { return null; }
    const row = document.createElement("div");
    row.className = "file-entry up";
    row.title = "回到上一层";
    const icon = document.createElement("span");
    icon.className = "file-entry-icon";
    icon.innerHTML = ICONS["arrow-up"];
    const name = document.createElement("span");
    name.className = "file-entry-name";
    name.textContent = "上一层";
    row.appendChild(icon);
    row.appendChild(name);
    row.addEventListener("click", goUpProjectDir);
    return row;
  }

  /** 现在看着的「项目目录」那一格该有「上一层」这一行时，把它摆到正文最上面。 */
  function prependFileUpRow() {
    if (!fileSidebar.body) { return; }
    const row = buildFileUpRow(fileSidebar.tabs[fileSidebar.active]);
    if (row) { fileSidebar.body.insertBefore(row, fileSidebar.body.firstChild); }
  }

  /** 那个文件的下载地址：同一条 `/file` 地址带 download=1（不设大小上限、按附件给）；目录没有下载这回事。 */
  function fileDownloadUrl(tab) {
    return sidebarUrl(tab, "") + "&download=1";
  }

  /** 图片那个显示地址用完了就放掉（换成别的图、切成正文、关掉标签都得放）。 */
  function releaseTabImage(tab) {
    if (!tab || !tab.imageUrl) { return; }
    try { URL.revokeObjectURL(tab.imageUrl); } catch (e) { /* 放不掉就算了 */ }
    tab.imageUrl = "";
  }

  /**
   * 把一张图显示出来：拿那条地址的回应当图片源，按这一列的宽度等比例缩。
   * 图片没有「链接说的那一行」可停，也不该画成一行行文字。
   */
  function renderFileImage(blob, tab) {
    const body = fileSidebar.body;
    if (!body) { return; }
    const url = URL.createObjectURL(blob);
    releaseTabImage(tab);
    tab.imageUrl = url;
    body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "file-image";
    const img = document.createElement("img");
    img.className = "file-image-img";
    img.alt = fileSidebarTabName(tab.path);
    img.src = url;
    wrap.appendChild(img);
    body.appendChild(wrap);
  }

  /**
   * 一份目录清单画进正文：一项一行（名字前一颗图标），点子目录就在这一格里往里走、点文件打开它。
   * 清单里那个相对写法就是下一次请求的路径，跟点消息流里的链接走同一条路
   *（开不开得了由后端那道边界管：指到目录外的条目点了给一句说明）。
   * 待在子目录里时，清单第一行是「上一层」（见 buildFileUpRow）。
   * @param tab 正看着的「项目目录」那一格（它现在待在哪一层决定要不要「上一层」那一行）
   */
  function renderDirListing(listing, tab) {
    const body = fileSidebar.body;
    if (!body) { return; }
    body.innerHTML = "";
    body.scrollTop = 0;   // 换到这一层：清单从头看（不是停在上一层读到的地方）
    const entries = (listing && listing.entries) || [];
    if (entries.length === 0) {
      showFileNote("这个目录是空的。");   // 空目录里也照样有「上一层」那一行（showFileNote 会摆上）
      return;
    }
    const frag = document.createDocumentFragment();
    const up = buildFileUpRow(tab);
    if (up) { frag.appendChild(up); }
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "file-entry" + (entry.dir ? " dir" : "");
      row.setAttribute("data-path", entry.path);
      row.title = entry.path;
      const icon = document.createElement("span");
      icon.className = "file-entry-icon";
      icon.innerHTML = entry.dir ? ICONS.folder : ICONS.files;
      const name = document.createElement("span");
      name.className = "file-entry-name";
      name.textContent = pathLabel(entry.name, entry.dir);
      row.appendChild(icon);
      row.appendChild(name);
      // 子目录就在「项目目录」这一格里往里走（不新开标签）、文件开一个新标签看
      row.addEventListener("click", () => openSidebarLink(entry.path, 0, !!entry.dir));
      frag.appendChild(row);
    });
    body.appendChild(frag);
    if (listing.truncated) {
      const more = document.createElement("div");
      more.className = "file-note";
      more.textContent = "这个目录里的东西太多，只列出了一部分。";
      body.appendChild(more);
    }
  }

  /**
   * 后端说不给看时的处理：
   *   - 太大（413）与二进制（415）：给一句人话再加一个能点去下载的链接（回应里带着字节数）；
   *   - 其余（没有这个文件、目录外）：就一句人话，没有东西可下。
   * 这两类回应也带着修改时间，存进标签，好让跟着刷新那轮能靠它省下重传。
   */
  async function showFileRefusal(resp, tab) {
    const text = (await resp.text()).trim() || "这个文件看不了（" + resp.status + "）。";
    const size = formatBytes(Number(resp.headers.get("X-File-Size") || ""));
    const name = fileSidebarTabName(tab.path);
    if (resp.status === 413) {
      showFileNote("太大" + (size ? "（" + size + "）" : "") + "，这里显示不了。",
        { url: fileDownloadUrl(tab), name: name, label: "点这里下载" });
      return;
    }
    if (resp.status === 415) {
      showFileNote("这是个二进制文件，没法当文字显示。",
        { url: fileDownloadUrl(tab), name: name, label: "下载" + (size ? "（" + size + "）" : "") });
      return;
    }
    showFileNote(text);
  }

  /**
   * 把一条 200 的回应画进正文：图片按图片显示；markdown 排好版渲染成文档（不留行号，
   * 链接里带的行号在这条路上等于没带）；其余当文本、一行一格带行号。
   * @returns 文本那一路点亮的那一行（图片与 markdown 文档没有行，给 null）
   */
  async function drawFileResponse(resp, tab) {
    const type = (resp.headers.get("Content-Type") || "").toLowerCase();
    if (type.indexOf("image/") === 0) {
      renderFileImage(await resp.blob(), tab);
      return null;
    }
    releaseTabImage(tab);   // 这个文件以前是张图（现在换成文本了），把那份地址放掉
    const text = await resp.text();
    if (isMarkdownPath(tab.path)) { renderFileMarkdown(text); return null; }
    return renderFileText(text, tab.line, tab.path);
  }

  /**
   * 把整段高亮好的 HTML 按行拆开：跨行的标签（块注释、模板串、Python 三引号串这些）在行尾
   * 收住、下一行开头再接上，每一行都是自己闭合的一段 HTML。
   * hljs 的输出只有 `<span …>` 与 `</span>` 两种标签、正文里的字符都转义过，所以这么拼出来
   * 的行丢进 innerHTML 是安全的，行数也不会多也不会少。
   * @returns 一行一段；行数跟原文对不上（理论上不该发生）就给 null，调用方退回黑白
   */
  function splitHighlightedLines(html, wantLines) {
    const lines = [];
    const open = [];          // 到这一行为止还开着的标签，下一行开头要原样接上
    let cur = "";
    let at = 0;
    const re = /<span[^>]*>|<\/span>|\n/g;
    let m;
    while ((m = re.exec(html))) {
      cur += html.slice(at, m.index);
      at = m.index + m[0].length;
      if (m[0] === "\n") {
        lines.push(cur + "</span>".repeat(open.length));
        cur = open.join("");
        continue;
      }
      cur += m[0];
      if (m[0] === "</span>") { open.pop(); } else { open.push(m[0]); }
    }
    lines.push(cur + html.slice(at) + "</span>".repeat(open.length));
    return lines.length === wantLines ? lines : null;
  }

  /**
   * 这个文件的每一行该上什么色：按扩展名认语言——跟消息流里认语言、认别名走同一处
   *（resolveHighlightLanguage：`js` 是 TypeScript 的别名、`json` 也有别名指过去、`h` 是 C++ 的别名）。
   * 认不出来、只有纯文本、太大、或者高亮中途出了岔子，都给 null：那几行老老实实黑白，
   * 不能因为这个文件显示不出来。
   * 整段高亮一次再拆行，不是一行一行单独高亮：跨多行的注释 / 模板串 / 文档串才有对的颜色。
   */
  function highlightFileLines(text, path) {
    if (!text || text.length > FILE_HIGHLIGHT_MAX_CHARS) { return null; }
    const { hljs } = globalThis.hljsBundle || {};
    if (!hljs) { return null; }
    const language = resolveHighlightLanguage(hljs, lastExt(path));
    if (!language || language === "plaintext") { return null; }
    try {
      return splitHighlightedLines(hljs.highlight(text, { language }).value, text.split("\n").length);
    } catch (e) { return null; }
  }

  /** 排好版渲染成文档的扩展名（跟消息流里认 markdown 文件那一族一样）。 */
  const MARKDOWN_EXT = new Set(["md", "mdx", "markdown"]);
  /** 这个文件是不是 markdown：是就排好版渲染成文档，而不是一行一行带行号。 */
  function isMarkdownPath(path) { return MARKDOWN_EXT.has(lastExt(path)); }

  /**
   * 把一个 markdown 文件渲染成文档：跟消息流里渲染正文走同一段（renderMarkdown），
   * 不另起一套。文档不留行号，所以链接里带的行号（`:12`）等于没带，也不报错。
   * 文档里的文件链接由文件侧边栏那段代点（见 buildFileSidebar），照旧开在这一列里。
   */
  function renderFileMarkdown(text) {
    const body = fileSidebar.body;
    if (!body) { return; }
    body.innerHTML = "";
    const doc = document.createElement("div");
    doc.className = "md file-md";
    doc.innerHTML = renderMarkdown(String(text));
    body.appendChild(doc);
  }

  /**
   * 把一个文件画出来：一行一格、带行号，hitLine 那一行点亮（0 = 不点亮）。
   * 本仓库认得的那几种语言按扩展名上色（见 highlightFileLines），其余黑白。
   * 只画，不管滚到哪儿（那是 scrollFileBody 的事）：返回点亮的那一行，没点亮就是 null。
   * @param text 文件全文（后端按 UTF-8 给回来的）
   * @param path 这个文件叫什么名字（按扩展名上色用）
   */
  function renderFileText(text, hitLine, path) {
    const body = fileSidebar.body;
    if (!body) { return null; }
    body.innerHTML = "";
    const lines = String(text).split("\n");
    // 文件末尾那个换行会多出一个空行：不画它（行号也就不会凭空多出一个）
    if (lines.length > 1 && lines[lines.length - 1] === "") { lines.pop(); }
    const colored = highlightFileLines(String(text), path);
    const frag = document.createDocumentFragment();
    let hitRow = null;
    lines.forEach((line, i) => {
      const row = document.createElement("div");
      row.className = "file-line";
      const num = document.createElement("span");
      num.className = "file-num";
      num.textContent = String(i + 1);
      const code = document.createElement("span");
      code.className = "file-text";
      if (colored) { code.innerHTML = colored[i]; } else { code.textContent = line; }
      row.appendChild(num);
      row.appendChild(code);
      if (hitLine > 0 && i + 1 === hitLine) { row.classList.add("hit"); hitRow = row; }
      frag.appendChild(row);
    });
    body.appendChild(frag);
    return hitRow;
  }

  /**
   * 把正文滚到该在的地方。
   * @param hitRow 点亮的那一行（没有就是 null）
   * @param centerOnLine 这次链接说的那一行（0 = 没有）：>0 就停在它那里、居中
   * @param savedTop 没有要停的行时，回到这个标签上次读到的地方
   */
  function scrollFileBody(hitRow, centerOnLine, savedTop) {
    const body = fileSidebar.body;
    if (!body) { return; }
    if (hitRow && centerOnLine > 0) {
      // 停在那一行：按两边的位置差算滚动量（scrollIntoView 会连外面那几层一起滚，不行）
      const bodyRect = body.getBoundingClientRect();
      const rowRect = hitRow.getBoundingClientRect();
      const delta = (rowRect.top - bodyRect.top) - (bodyRect.height - rowRect.height) / 2;
      body.scrollTop = Math.max(0, body.scrollTop + delta);
      return;
    }
    body.scrollTop = Number(savedTop) > 0 ? Number(savedTop) : 0;
  }

  /**
   * 现在这个标签该取哪条地址：文件走 `/file`（带 mtime 就是「没变就别给正文」那问法），
   * 「项目目录」那一格走 `/dir`；两条都是只读的、边界也同一套（见后端）。
   */
  function sidebarUrl(tab, mtime) {
    const base = (tab.proj ? "/dir?" : "/file?") + "session=" + encodeURIComponent(activeId || "")
        + "&path=" + encodeURIComponent(tab.path);
    return mtime ? base + "&mtime=" + encodeURIComponent(mtime) : base;
  }

  /**
   * 去后端把现在这个标签的内容取回来画上：文件画成正文 / 图片 / 一句说明（看不了时），
   * 目录画成一张清单；看不了就画一句人话。两条地址取的与画的就这一点不同。
   * @param linkLine 这次链接说的那一行（1 起）；0 = 没有要停的行，回这个标签上次读到的地方
   */
  function loadIntoSidebar(linkLine) {
    const tab = fileSidebar.tabs[fileSidebar.active];
    if (!tab) { return; }
    const token = ++fileSidebar.token;
    tab.loading = true;
    fetch(sidebarUrl(tab, "")).then(async (resp) => {
      tab.loading = false;
      if (token !== fileSidebar.token) { return; }   // 已经换成别的标签了，这条回应丢掉
      tab.mtime = resp.headers.get("X-File-Mtime") || "";   // 看不了时也记：跟着刷新那轮靠它省重传
      if (resp.status !== 200) { await showFileRefusal(resp, tab); return; }
      if (tab.proj) { renderDirListing(await resp.json(), tab); return; }
      scrollFileBody(await drawFileResponse(resp, tab), linkLine, tab.scrollTop);
    }).catch(() => {
      tab.loading = false;
      if (token !== fileSidebar.token) { return; }
      showFileNote("读不出来：连不上后端。");
    });
  }

  /**
   * 跟着刷新：问一次现在看着的这个文件变了没。
   *
   * 带上上次拿到的那份内容的修改时间（条件请求）：没变后端回 204，这边一个字节都不动；
   * 变了才把新内容取回来重画（文本、图片、二进制、太大各按各的画法），并把「读到哪儿」
   * 照原样放回去——不许跳回顶部，也不许跳回这个标签上次切走时的位置。看不了的文件
   *（没有 / 太大 / 目录外）也一样问：文件后来被建出来 / 改小 / 挪回来，这一列就跟着换成内容。
   */
  function pollActiveFile() {
    if (filePolling) { return; }               // 上一条还在路上，别越堆越多
    const at = fileSidebar.active;
    const tab = fileSidebar.tabs[at];
    const body = fileSidebar.body;
    if (!tab || !body || tab.loading) { return; }   // 还没开文件 / 还在取：这一轮先不问
    if (tab.proj) { return; }   // 目录不跟着刷新：清单不是「正看着的那个文件」，点一下才重新列
    const token = fileSidebar.token;
    filePolling = true;
    fetch(sidebarUrl(tab, tab.mtime)).then(async (resp) => {
      if (token !== fileSidebar.token || fileSidebar.active !== at) { return; }   // 换了标签 / 切了会话 / 收起
      if (resp.status === 204) { return; }   // 没变：正文一个字节都没过来
      tab.mtime = resp.headers.get("X-File-Mtime") || "";
      if (resp.status !== 200) {
        await showFileRefusal(resp, tab);
        return;
      }
      const top = body.scrollTop;
      const left = body.scrollLeft;
      await drawFileResponse(resp, tab);
      body.scrollTop = top;      // 换上新内容，读到哪儿还停在哪儿
      body.scrollLeft = left;
      tab.scrollTop = top;
    }).catch(() => {
      // 这一轮没连上就算了：正文留着，下一轮再问（别把人正读的东西换成一句报错）
    }).then(() => { filePolling = false; });
  }

  /** 窄窗里只留一块侧边栏：右边那块此刻露着就收起来（两块都常驻时不动它）。 */
  function closeRightSidebarForFile() {
    if (fileSidebarWide()) { return; }
    const st = modalView.state;
    if (st && st.kind === "workspace" && !modalView.root.classList.contains("hidden")) { cancelPicker(modalView); return; }
    if (sidebarEnabled() && sidebarDocked()) { collapseSidebar(); }
  }

  /** 右边那块要开出来了：窄窗里（左边这块是滑入式）先把左边收起来。 */
  function closeFileSidebarForRightSidebar() {
    if (!fileSidebar.open || fileSidebarWide()) { return; }
    setFileSidebarOpen(false);
  }

  /** 开 / 收这一列（点顶条那颗按钮、点外面、点链接自动开），并把结果记在这台设备里。 */
  function setFileSidebarOpen(open) {
    if (!fileSidebar.root) { return; }
    fileSidebar.open = !!open;
    rememberFileSidebar(fileSidebar.open);
    if (!fileSidebar.open) { fileSidebar.token++; }   // 还等着的那条回应别再画进来
    syncFileSidebarLayout();
    if (fileSidebar.open) {
      ensureProjectDirTab();   // 空着的时候先把「项目目录」那一格摆上（会话目录还没认识就留那句提示）
      if (fileSidebar.active < 0) { showFileNote(FILE_SIDEBAR_HINT); }
      else { pollActiveFile(); }   // 收起那阵子文件可能改过了：马上问一次，别等下一个节拍
    }
  }

  /** 顶条左边那颗按钮：开着就收、收着就开。 */
  function toggleFileSidebar() {
    if (fileSidebar.open) { setFileSidebarOpen(false); return; }
    closeRightSidebarForFile();
    setFileSidebarOpen(true);
  }

  /** 这一列角上那颗折行开关：「长行折起来」与「一行就是一行、横向滚」两个来回切，选的那个记在这台设备里。 */
  function toggleFileSidebarWrap() {
    fileSidebar.wrap = !fileSidebar.wrap;
    rememberFileSidebarWrap(fileSidebar.wrap);
    syncFileSidebarLayout();
  }

  /**
   * 点一条链接（消息流里的文件 / 目录链接，或者清单上的一项）：目录去「项目目录」那一格里走
   *（不占标签），文件开一个自己的标签看。
   * @param dir 这是个目录（消息流那边看 `data-dir`，清单那边看 `entry.dir`）
   */
  function openSidebarLink(path, line, dir) {
    if (dir) { openDirInProjectTab(path); return; }
    openFileInSidebar(path, line);
  }

  /**
   * 点链接、进目录之前的张罗：窄窗里把右边那块让开，把「项目目录」那一格摆到第一格
   *（还没有就摆上；会话目录还不认识时它会留一句提示），再把这一列开出来。
   */
  function prepareFileSidebar() {
    closeRightSidebarForFile();
    addProjectDirTab();   // 第一格留给「项目目录」（只摆不取，排在文件前面）
    if (!fileSidebar.open) { setFileSidebarOpen(true); } else { syncFileSidebarLayout(); }
  }

  /**
   * 点消息流里的文件链接（或者这一列清单上的一个文件）：把那个文件取回来显示
   *（停在链接说的那一行）。已经开着这个文件就切回它那个标签、按这次链接说的行滚过去，
   * 不再开一个重复的标签。
   */
  function openFileInSidebar(path, line) {
    if (!fileSidebar.root || !path) { return; }
    prepareFileSidebar();
    let at = fileSidebarTabIndex(path);
    if (at < 0) {
      fileSidebar.tabs.push(fileSidebarNewTab(path, false));
      at = fileSidebar.tabs.length - 1;
    }
    showFileTab(at, line);
  }

  /**
   * 点一个目录：在「项目目录」那一格里走（目录不占标签）——切到那一格、换成这一层重新列出来；
   * 本来就在那一格的话也一样（相当于重新列一次）。会话目录还没认识就先不换层：
   * 这一列照开，上面留着那句提示，等会话列表到了再长出来。
   * @param path 相对会话目录的写法（`dirA/sub`；空 / `.` 就是会话目录本身那一层）
   */
  function openDirInProjectTab(path) {
    if (!fileSidebar.root) { return; }
    const key = String(path || "").replace(/\/+$/, "") || FILE_SIDEBAR_PROJECT_PATH;
    prepareFileSidebar();
    const at = fileSidebarProjectIndex();
    if (at < 0) { return; }
    fileSidebar.tabs[at].path = key;
    showFileTab(at, 0);
  }

  /** 上一层目录的相对写法（`dirA/sub` → `dirA`；`dirA` → `.`，就是会话目录本身）。 */
  function parentDirPath(path) {
    const parts = String(path || "").split("/").filter((x) => x.length > 0);
    parts.pop();
    return parts.length > 0 ? parts.join("/") : FILE_SIDEBAR_PROJECT_PATH;
  }

  /**
   * 点清单第一行那颗「上一层」：「项目目录」那一格退到上一层，还是这一格那份清单
   *（到会话目录本身那一层就退不动了，那一行也不出现，见 buildFileUpRow）。
   */
  function goUpProjectDir() {
    const at = fileSidebarProjectIndex();
    const tab = at >= 0 ? fileSidebar.tabs[at] : null;
    if (!tab || tab.path === FILE_SIDEBAR_PROJECT_PATH) { return; }
    tab.path = parentDirPath(tab.path);
    showFileTab(at, 0);
  }

  /**
   * 点一个文件的时候去哪儿：浏览器页面里开左边这一列看（后端自己读），插件里的对话面板里
   * 照旧交给编辑器打开。正文里的文件链接与工具卡片那颗「跳转」都走这里，别各写一遍。
   * @param dir 这是个目录（只有正文里以斜杠结尾的写法会带；工具卡片那颗按钮没有这种）
   */
  function openFileForUser(path, line, col, dir) {
    if (!path) { return; }
    if (fileSidebar.root) { openSidebarLink(path, line, dir); return; }
    vscode.postMessage({ type: "openFile", path, line, col });
  }

  /** 切会话：这一列里那些文件属于上一个会话的目录，标签全清掉（别把别人的东西留在界面上）；
   *  「项目目录」那一格换成新会话的目录重新给出来。 */
  function resetFileSidebarForSession() {
    if (!fileSidebar.root) { return; }
    fileSidebar.token++;
    fileSidebar.tabs.forEach(releaseTabImage);   // 上一个会话里看过的图：那些显示地址放掉
    fileSidebar.tabs = [];
    fileSidebar.active = -1;
    setFileSidebarTitle(null);
    renderFileTabs();
    showFileNote(FILE_SIDEBAR_HINT);
    ensureProjectDirTab();   // 开着就换成新会话的目录；收着的那就等打开时再说
  }

  /**
   * 拖右边那条缝改宽度（只有常驻时才给拖，见 chat.css 的 #fileResize）。
   * 按住之后指针捕获在这一格上，拖到面板外面、拖到窗口边上都不断线。
   * 拖动中只动这一列自己：它是浮在对话上面的（position: fixed），动它不碰版面；
   * 对话那边空出多宽由 body.file-dock::before 那块占位决定，那块先冻着不动——
   * 它一动，整屏消息就得重新排字（长会话一次几十毫秒，见 docs/adr/0002 里量出来的数）。
   * 松手那一下才落到版式上（对话跟着排一次），也是到那一下才记进本机。
   */
  function wireFileSidebarResize(handle) {
    if (!handle) { return; }
    let dragging = false;
    /** 按住的那一点离右边那条线有多远：拖起来那条线不往指针底下跳。 */
    let grabOffset = 0;
    const move = (e) => {
      if (!dragging) { return; }
      const w = clampFileSidebarWidth(e.clientX - grabOffset, true);
      fileSidebar.width = w;
      fileSidebar.root.style.width = w + "px";   // 只写在这一格上：CSS 变量别动，那块占位看的正是它
    };
    const finish = () => {
      if (!dragging) { return; }
      dragging = false;
      document.body.classList.remove("file-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      fileSidebar.root.style.width = "";   // 交回给 CSS 变量：这一下对话才跟着排（一次）
      applyFileSidebarWidth();
      rememberFileSidebarWidth(fileSidebar.width);
      // 顶条那道横线的高度是量出来的，跟对话那边的宽度有关：宽度一定下来就得重量一次
      syncDockHeaderHeight();
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !fileSidebarDocked()) { return; }   // 滑入 / 铺满那两种摆法不给拖
      e.preventDefault();
      dragging = true;
      grabOffset = e.clientX - handle.parentNode.getBoundingClientRect().width;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 抓不住也能拖：window 上挂着监听 */ }
      document.body.classList.add("file-resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      move(e);
    });
  }

  // 这一列只在浏览器页面里搭出来：插件里的对话面板里连这一列的容器都没有。
  (function buildFileSidebar() {
    if (IN_WEBVIEW) { return; }
    const root = document.createElement("div");
    root.id = "fileSidebar";
    root.innerHTML =
      '<div id="filePanel" class="pk-panel">' +
        '<div id="fileHeader" class="pk-header">' +
          '<span id="fileTitle" class="pk-header-title">文件</span>' +
          '<button id="fileClose" class="pk-header-close" type="button" title="收起" aria-label="收起">' + ICONS["close-bold"] + '</button>' +
        '</div>' +
        '<div id="fileTabs"></div>' +
        '<div id="fileBody" class="pk-body"></div>' +
        '<button id="fileWrap" type="button" aria-label="折行开关" aria-pressed="false">' + ICONS.wrap + '</button>' +
      '</div>' +
      // 拖宽度的那条缝：摆在面板外面（面板自己 overflow: hidden，摆在里面就被它裁掉了）
      '<div id="fileResize" title="拖这里改宽度"></div>';
    const backdrop = document.createElement("div");
    backdrop.id = "fileBackdrop";
    document.body.appendChild(root);
    document.body.appendChild(backdrop);
    fileSidebar.root = root;
    fileSidebar.header = root.querySelector("#fileHeader");
    fileSidebar.title = root.querySelector("#fileTitle");
    fileSidebar.tabsEl = root.querySelector("#fileTabs");
    fileSidebar.body = root.querySelector("#fileBody");
    fileSidebar.open = readFileSidebarWanted();
    fileSidebar.wrap = readFileSidebarWrapWanted();
    fileSidebar.width = readFileSidebarWidthWanted();
    fileSidebar.resize = root.querySelector("#fileResize");
    wireFileSidebarResize(fileSidebar.resize);
    root.querySelector("#fileClose").addEventListener("click", () => setFileSidebarOpen(false));
    root.querySelector("#fileWrap").addEventListener("click", toggleFileSidebarWrap);
    backdrop.addEventListener("click", () => setFileSidebarOpen(false));
    syncFileSidebarLayout();
    if (fileSidebar.open) { ensureProjectDirTab(); }
    // 拖窗口过那道门槛：常驻 / 滑入两种摆法跟着换
    window.addEventListener("resize", () => { if (fileSidebar.open) { syncFileSidebarLayout(); } });
    // 文档里那些文件链接（renderMarkdown 挂上去的）点了也开在这一列里：跟消息流里的链接同一个去处。
    //（没有这一下，`href="#"` 会按浏览器默认行为把页面卷回去。）
    fileSidebar.body.addEventListener("click", (e) => {
      const a = e.target.closest("a.file-link");
      if (!a) { return; }
      e.preventDefault();
      const path = a.getAttribute("data-file");
      if (!path) { return; }
      openSidebarLink(path, a.dataset.line ? parseInt(a.dataset.line, 10) : 0, a.getAttribute("data-dir") === "1");
    });
    // 跟着刷新：开着而且有正看着的文件时，隔一会儿问一次（页面在后台时不问：手机上别白耗电）
    setInterval(() => {
      if (!fileSidebar.open || document.hidden) { return; }
      pollActiveFile();
    }, FILE_SIDEBAR_POLL_MS);
    // 顶条左边那颗按钮（由 browserBridge.js 建）点它走这里
    window.pichatFileSidebar = { toggle: toggleFileSidebar };
  })();

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
  function selectModelIndex(view, st, idx, scroll) {
    const item = st.filtered[idx];
    if (!item) { return; }
    st.draftModel = item;
    st.draftThinking = defaultThinkingForModel(st, item);
    renderPickerItems(view);
    if (scroll) {
      const active = view.body.querySelector(".pk-model-item.active");
      if (active) { active.scrollIntoView({ block: "nearest" }); }
    }
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
  function renderModelFooter(view, st) {
    view.footer.innerHTML = "";
    view.footer.classList.remove("hidden");
    view.footer.classList.add("pk-model-footer");
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
    view.footer.appendChild(summary);
    const actions = document.createElement("div"); actions.className = "pk-footer-actions";
    const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => cancelPicker(view));
    actions.appendChild(cancelBtn);
    const confirmBtn = document.createElement("button"); confirmBtn.type = "button"; confirmBtn.className = "primary"; confirmBtn.textContent = "确认切换";
    const ready = !!st.draftModel && (!st.draftModel.reasoning || modelThinkingLevels(st.draftModel).length > 0);
    confirmBtn.disabled = !ready || !modelDraftChanged(st);
    confirmBtn.addEventListener("click", () => submitModelPicker(view));
    actions.appendChild(confirmBtn);
    view.footer.appendChild(actions);
  }

  /** 面板筛选框里的词（这一格没有筛选框、或者还没打字，都是空串）。 */
  function pickerQuery(view) {
    return ((view.search ? view.search.value : "") || "").toLowerCase().trim();
  }

  /**
   * 只重画「项目与会话」里的一格：「正在对话」（上半）或者「工作区」（下半）。
   * 另一格原样留着，连它滚到哪儿都不动。哪一格该重画见 paintWorkspacePanel。
   * @param only 留下来的那些行（跟 renderPickerRows 一个意思）
   */
  function redrawPickerPane(view, pane, only) {
    const st = view.state;
    if (!st || !pane) { return; }
    const keepScroll = pane.scrollTop;
    pane.innerHTML = "";
    renderPickerRows(view, only);
    // 下半那一格末尾那颗「加载更多」（两块面板各挂在自己那一格上，这一颗挂在下半）
    if (pane === view.spacePane && st.kind === "workspace" && st.spacesHasMore) {
      pane.appendChild(buildLoadMoreBtn(view, st, "spaces"));
    }
    pane.scrollTop = keepScroll;
  }

  /**
   * 「项目与会话」面板：比一比上下两格现在该长什么样，只重画真的变了的那一格，
   * 没变的那一格一根手指都不碰。
   *
   * 上半是「正在对话」、下半是「工作区 + 展开的那些组」：会话多一条、状态变一下
   * （开始跑 / 跑完 / 换了当前 / 点过关闭）只动上半；组展开收起、某一组取回一批只动下半。
   *
   * 为什么不整块重画：整块重画把下半那一大块连展开的组一起重来一遍 —— 新建一个会话、
   * 宿主重推一份面板，都会让展开的组先塌下去再长回来，看着就是整列闪一下。
   */
  function paintWorkspacePanel(view) {
    const st = view.state;
    if (!st || st.kind !== "workspace") { return; }
    // 头一回（这一块还没画出来）：整份画一遍
    if (!view.sessionPane || !view.spacePane) { renderPickerItems(view); return; }
    st.filtered = st.items.filter((it) => pickerItemMatch(it, st.kind, pickerQuery(view)));
    // 一行都没有（一个工作区都列不出来）：整份走，那句「列表为空」才画得出来
    if (st.filtered.length === 0) { renderPickerItems(view); return; }
    const openSig = openSessionsSignature(st.items.filter((it) => it.__section === "open"));
    const spaceSig = spaceRowsSignature(view);
    const openChanged = openSig !== view.openSessionsShown;
    const spaceChanged = spaceSig !== view.spaceRowsShown;
    if (!openChanged && !spaceChanged) { return; }
    if (openChanged) {
      view.openSessionsShown = openSig;
      redrawPickerPane(view, view.sessionPane, (it) => it.__section === "open");
      // 下面那些行上的「已打开」跟着会话开开关关变，就地加减，不重画那一格
      syncOpenTagsIn(view.spacePane);
    }
    if (spaceChanged) {
      view.spaceRowsShown = spaceSig;
      redrawPickerPane(view, view.spacePane, (it) => it.__section !== "open");
    }
  }

  /**
   * 工作区那一格里，各组会话行上的「已打开」那颗小标：会话开开关关时就地加减。
   * 那一格的结构没变，只是某几行要不要那颗标变了，不值得整格重画。
   */
  function syncOpenTagsIn(pane) {
    if (!pane) { return; }
    pane.querySelectorAll(".pk-item.pk-group-session").forEach((el) => {
      const main = el.querySelector(".pk-history-main");
      if (!main) { return; }
      let right = el.querySelector(".pk-history-right");
      const has = !!el.querySelector(".pk-open-tag");
      const want = sessionOpenForFile(el.dataset.file || "");
      if (want === has) { return; }
      if (want) {
        if (!right) { right = document.createElement("span"); right.className = "pk-history-right"; main.appendChild(right); }
        const tag = document.createElement("span"); tag.className = "pk-open-tag"; tag.textContent = "已打开";
        right.insertBefore(tag, right.firstChild);
      } else if (right) {
        const tag = right.querySelector(".pk-open-tag");
        if (tag) { tag.remove(); }
        if (!right.childNodes.length) { right.remove(); }
      }
    });
  }

  /** 这一行该画进哪一格：常驻那一列（「项目与会话」）上半是「正在对话」、下半是「工作区」；
   *  其余面板（选模型 / 历史抽屉 / 文件夹）不分格，就画在面板身上。 */
  function pickerRowHost(view, item) {
    if (!view.sessionPane) { return view.body; }
    return item.__section === "open" ? view.sessionPane : view.spacePane;
  }

  function renderPickerItems(view = modalView) {
    const st = view.state;
    if (!st) { return; }
    const q = pickerQuery(view);
    st.filtered = st.items.filter((it) => pickerItemMatch(it, st.kind, q));
    // 刚画出来的「正在对话」那一段长什么样：之后推送内容一样就不重画（见 paintWorkspacePanel）
    view.openSessionsShown = openSessionsSignature(st.items.filter((it) => it.__section === "open"));
    // 切换模型那层：草稿模型被筛选词筛掉了就作废（底下那颗「确认切换」跟着变灰）；
    // 列表里不再有「选中的那一行」这回事：鼠标 / 触摸点哪行就是哪行，扫过不改动什么。
    if (st.kind === "model" && st.draftModel && st.filtered.indexOf(st.draftModel) < 0) {
      st.draftModel = null;
      st.draftThinking = undefined;
    }
    // 重画前先把滚动位置记下来（渲染完再放回去）：面板整份换数据时会走这里，
    // 不能把人正看着的那一段顶回顶部。会话 / 工作区两块各滚各的，分开记。
    const keepScroll = {
      body: view.body.scrollTop,
      session: view.sessionPane ? view.sessionPane.scrollTop : 0,
      space: view.spacePane ? view.spacePane.scrollTop : 0,
    };
    view.body.innerHTML = "";
    view.body.classList.toggle("pk-workspace-body", st.kind === "workspace");
    view.sessionPane = null;
    view.spacePane = null;
    /** 渲染完把滚动位置放回原处（内容变短时浏览器自己会夹到最底下）。 */
    const restoreScroll = () => {
      view.body.scrollTop = keepScroll.body;
      if (view.sessionPane) { view.sessionPane.scrollTop = keepScroll.session; }
      if (view.spacePane) { view.spacePane.scrollTop = keepScroll.space; }
    };
    if (st.kind === "workspace") {
      view.sessionPane = document.createElement("div"); view.sessionPane.className = "pk-workspace-pane pk-session-pane";
      view.spacePane = document.createElement("div"); view.spacePane.className = "pk-workspace-pane pk-space-pane";
      view.body.appendChild(view.sessionPane); view.body.appendChild(view.spacePane);
      // 刚画出来的上下两格长什么样：之后推送来时内容没变就不动它（见 paintWorkspacePanel）
      view.spaceRowsShown = spaceRowsSignature(view);
    }
    if (st.filtered.length === 0) {
      const empty = document.createElement("div"); empty.className = "pk-empty";
      empty.textContent = q ? "没有匹配项。" : "列表为空。";
      view.body.appendChild(empty);
      if (st.kind === "history" && st.historyHasMore) { view.body.appendChild(buildLoadMoreBtn(view, st, "sessions")); }
      if (st.kind === "model") { renderModelFooter(view, st); }
      restoreScroll();
      return;
    }
    renderPickerRows(view);
    // 两个面板各有自己的滚动区和加载按钮。
    if (st.kind === "history" && st.historyHasMore) {
      view.body.appendChild(buildLoadMoreBtn(view, st, "sessions"));
    }
    if (st.kind === "workspace" && st.spacesHasMore) {
      view.spacePane.appendChild(buildLoadMoreBtn(view, st, "spaces"));
    }
    if (st.kind === "model") { renderModelFooter(view, st); }
    restoreScroll();
  }

  /**
   * 把 st.filtered 里的行画出来（画进哪一格见 pickerRowHost）。
   * 序号一律按 st.filtered 数（行上那颗点击认的是它在列表里的第几行，见 confirmPicker）。
   * @param only 只画满足它的那些行（只重画一格时用）；不填 = 全都画
   */
  function renderPickerRows(view, only) {
    const st = view.state;
    let lastSection = null;
    let lastModelProv = null;
    st.filtered.forEach((item, idx) => {
      if (only && !only(item)) { return; }
      if (st.kind === "model") {
        // provider 分组分隔线：host 已按 provider 排序，同 provider 项连续；
        // 标题带组内数量（随搜索过滤实时重算），无 provider 归入“其他”。
        if ((item.provider || "") !== lastModelProv) {
          lastModelProv = item.provider || "";
          const runCount = st.filtered.filter((x) => (x.provider || "") === lastModelProv).length;
          const sep = document.createElement("div"); sep.className = "pk-section pk-provider";
          sep.textContent = (item.provider || "其他") + " (" + runCount + ")";
          view.body.appendChild(sep);
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
        el.addEventListener("click", () => selectModelIndex(view, st, idx, true));
        view.body.appendChild(el);
        return;
      }

      // 「项目与会话」面板：除了「正在对话」那一节，其余（工作区行、展开的那几组会话）都画在工作区那块里，
      // 它们自己一个滚动区。
      const sectionPane = pickerRowHost(view, item);
      if (item.section && item.section !== lastSection) {
        lastSection = item.section;
        const sep = document.createElement("div"); sep.className = "pk-section";
        // 「工作区」那一行右边摆一颗加号（原来是列表里的一行「打开文件夹…」）：
        // 挑一个别的文件夹当工作区，就在那里开新会话（见 chatHost.ts 的 workspaceBrowse 那条）。
        const spaceHead = st.kind === "workspace" && item.__section === "space";
        const label = document.createElement("span"); label.className = "pk-section-text";
        label.textContent = item.section;
        sep.appendChild(label);
        if (spaceHead) {
          sep.classList.add("pk-section-with-add");
          const add = document.createElement("button");
          add.type = "button"; add.className = "pk-section-add-btn";
          add.title = "打开文件夹…"; add.setAttribute("aria-label", "打开文件夹");
          add.innerHTML = ICONS.add;
          add.addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "workspaceBrowse" });
          });
          sep.appendChild(add);
        }
        sectionPane.appendChild(sep);
      }
      const el = document.createElement("div");
      el.className = "pk-item";
      if (st.kind === "workspace" && item.__section === "space") {
        el.classList.add("pk-space");
      } else if (st.kind === "workspace" && item.__section === "groupSession") {
        el.classList.add("pk-session", "pk-group-session");
      }
      if (item.__section === "groupMore") {
        // 那一组的「加载更多」：卡在组里末尾，点它接着加这一组的
        const g = groupState(st, item.groupPath);
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "pk-loadmore pk-group-more";
        btn.textContent = g.loading ? "加载中…" : "加载更多";
        btn.disabled = !!g.loading;
        btn.addEventListener("click", () => {
          if (g.loading) { return; }
          requestGroupPage(view, item.groupPath, g.nextOffset);
          repaintPickerPanel(view);
        });
        sectionPane.appendChild(btn);
        return;
      }
      if (item.__section === "open") {
        // 「正在对话」：开着的会话（子会话缩进挂在主会话下面）。
        // 主会话只有在建会话、当前会话、在跑的才加粗 / 点蓝；历史列表里那套字号不动。
        el.classList.add("pk-history", "pk-open");
        if (item.current) { el.classList.add("current"); }
        if (item.depth > 0) { el.classList.add("pk-open-child"); }
        // 行首那一块（子会话的拐角箭头、那颗小点、名字）：普通行与确认条共用这一份
        // （确认条只是行尾那颗叉旁边多一颗勾，行里的东西一点不动：关的是哪一个照样看得见）。
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
        if (item.pendingClose) {
          // 点过行尾那颗叉：整行底色变红，行尾多一颗勾——点勾才真关，点叉撤销。
          el.classList.add("pk-open-confirm");
          const yes = document.createElement("button");
          yes.type = "button"; yes.className = "pk-open-yes";
          yes.title = "关闭这个会话";
          yes.setAttribute("aria-label", "关闭这个会话");
          yes.innerHTML = ICONS["check-bold"];
          yes.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(item.sessionId); });
          const no = document.createElement("button");
          no.type = "button"; no.className = "pk-open-no";
          no.title = "取消";
          no.setAttribute("aria-label", "取消");
          no.innerHTML = ICONS["close-bold"];
          no.addEventListener("click", (e) => {
            e.stopPropagation();
            cancelPendingClose();
            refreshOpenSessionsInPicker();
          });
          el.appendChild(yes); el.appendChild(no);
        } else {
          // 关闭按钮放行尾：点行是切过去（大目标），点这颗才关（还要再确认一下）。
          const close = document.createElement("span");
          close.className = "pk-open-close";
          close.title = "关闭这个会话";
          close.setAttribute("aria-label", "关闭这个会话");
          close.innerHTML = ICONS["close-bold"];
          close.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(item.sessionId); });
          el.appendChild(close);
        }
        el.title = tooltipWithCwd(item.label, item.cwd);
      } else if (st.kind === "history" || (st.kind === "workspace" && item.__section === "groupSession")) {
        el.classList.add("pk-history");
        if (item.current) { el.classList.add("current"); }
        // 这一行是哪个会话文件（「已打开」那颗小标要靠它就地加减，见 syncOpenTagsIn）
        el.dataset.file = item.file || "";
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
        // 工作区行：就是个组头——小三角、文件夹图标、名字 + 目录路径一行。
        // 点整行展开 / 收起；行尾那颗加号是在这个目录里开新会话。
        el.classList.add("pk-history", "pk-space-head");
        // 不标「当前工作区」的选中态：几个工作区里的会话可以同时开着，标一个“当前”反倒误导
        // （哪个目录是当前会话所在的，看它排在最上面、看「正在对话」那一段就行）
        const expanded = groupExpanded(item.file);
        if (expanded) { el.classList.add("expanded"); }
        const main = document.createElement("div"); main.className = "pk-history-main";
        // 行首那个小三角（画的是朝右，展开时 CSS 转 90° 成朝下）
        const caret = document.createElement("span"); caret.className = "pk-space-caret"; caret.innerHTML = CHEVRON_SVG;
        main.appendChild(caret);
        const icon = document.createElement("span"); icon.className = "pk-row-icon"; icon.innerHTML = ICONS.folder;
        main.appendChild(icon);
        const title = document.createElement("span"); title.className = "pk-history-title"; title.textContent = item.label || "";
        main.appendChild(title);
        // 目录的完整路径就摆在名字后面（淡淡的；太长从尾巴上截，整条路径鼠标停上去还能看到）：
        // 名字前面那一段父目录才是认目录的关键，所以截的是尾巴不是开头。
        if (item.folderPath) {
          const p = document.createElement("span"); p.className = "pk-space-path-inline"; p.textContent = item.folderPath;
          main.appendChild(p);
        }
        const right = document.createElement("span"); right.className = "pk-history-right";
        if (item.count > 0) { const c = document.createElement("span"); c.className = "pk-history-count"; c.textContent = String(item.count); right.appendChild(c); }
        if (item.lastActivity) { const a = document.createElement("span"); a.className = "pk-history-age"; a.textContent = pickerRelTime(item.lastActivity); right.appendChild(a); }
        if (right.childNodes.length) { main.appendChild(right); }
        // 行尾那颗加号（鼠标停在这一行才露出来，触屏上常显），目录明写在消息里
        const add = document.createElement("button");
        add.type = "button"; add.className = "pk-space-add";
        add.title = "在 " + (item.folderPath || item.label || "") + " 新建会话";
        add.setAttribute("aria-label", "在这个工作区新建会话");
        add.innerHTML = ICONS.add;
        add.addEventListener("click", (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: "newSessionInWorkspace", path: item.file });
        });
        main.appendChild(add);
        el.appendChild(main);
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
      if (["history", "options", "workspace", "folders"].indexOf(st.kind) < 0 && item.label) {
        const t = document.createElement("div"); t.className = "pk-title";
        t.textContent = String(item.label);
        el.appendChild(t);
      }
      // 鼠标扫过不改「选中的那一行」：这里已经没有这一回事了（列表只认点哪行是哪行，
      // 鼠标底下那一行归 CSS 的 :hover，移开就灭）。
      // 认的是这一行自己（不是它在列表里的第几行）：某一格单独重画时行序会变，
      // 按序号认就会点到隔壁那一条去（见 paintWorkspacePanel）。
      el.addEventListener("click", () => { confirmPicker(item, view); });
      sectionPane.appendChild(el);
    });
  }
  /**
   * 「加载更多」那颗按钮。which = "sessions" 是上半会话那块的，"spaces" 是下半工作区那块的；
   * 两块各记各的加载中状态（同时点也不会互相把按钮弄乱）。
   */
  function buildLoadMoreBtn(view, st, which) {
    const isSpaces = which === "spaces";
    const loading = isSpaces ? st.spacesLoading : st.historyLoading;
    const btn = document.createElement("button");
    btn.className = "pk-loadmore";
    btn.textContent = loading ? "加载中…" : "加载更多";
    btn.disabled = !!loading;
    btn.addEventListener("click", () => {
      if (loading) { return; }
      if (isSpaces) { st.spacesLoading = true; } else { st.historyLoading = true; }
      repaintPickerPanel(view);
      // 宿主回来的那批不带“哪一块面板点的”：这里先记一笔（浮层那份与常驻那一列两边都可能点）
      loadMoreWaiters[which].push(view);
      vscode.postMessage({ type: isSpaces ? "workspaceLoadMore" : "historyLoadMore" });
    });
    return btn;
  }

  /** 点过「加载更多」的面板（先来后到），宿主回来的那批按它对上主。 */
  const loadMoreWaiters = { sessions: [], spaces: [] };

  /**
   * 「加载更多」回来的那批记到哪块面板上：先看是哪一块点的（按先来后到），
   * 没记着（重连之后、旧版界面）就按正在画着的那种面板找一块。
   */
  function takeLoadMoreView(which, kinds) {
    const queue = loadMoreWaiters[which];
    while (queue.length) {
      const v = queue.shift();
      if (v.state && kinds.indexOf(v.state.kind) >= 0) { return v; }
    }
    for (let i = 0; i < kinds.length; i++) {
      const v = viewShowing(kinds[i]);
      if (v) { return v; }
    }
    return null;
  }
  function submitModelPicker(view) {
    const st = view.state;
    if (!st || st.kind !== "model" || !st.draftModel) { return; }
    const ready = !st.draftModel.reasoning || modelThinkingLevels(st.draftModel).length > 0;
    if (!ready || !modelDraftChanged(st)) { return; }
    const payload = {
      provider: st.draftModel.provider || "",
      modelId: st.draftModel.id,
      thinkingLevel: st.draftThinking,
    };
    hidePicker(view);
    vscode.postMessage({ type: "pickerChoice", kind: "model", payload });
  }
  function confirmPicker(item, view = modalView) {
    const st = view.state; if (!st) { return; }
    if (st.kind === "model") { submitModelPicker(view); return; }
    if (!item) { return; }
    const kind = st.kind;
    // 常驻那一列里点一行 = “用一下”，不是“选完就走”：面板留着接着点下一行
    const closeFirst = () => { if (!view.keepOpen) { hidePicker(view); } };
    if (st.toggle || item.behavior === "toggle") {
      vscode.postMessage({ type: "pickerToggle", kind, action: item.action, value: item.value });
      return;
    }
    // 「正在对话」段：点行就是切过去（不新开、不重载），行尾那颗 × 是关闭（要再点一下确认）。
    // 确认条正开着的时候点行身也是切过去：先把确认条撤掉 —— 点勾才真关，行身不能替那颗勾点实了。
    if (item.__section === "open") {
      if (item.pendingClose) { cancelPendingClose(); refreshOpenSessionsInPicker(); }
      closeFirst();
      vscode.postMessage({ type: "switchSession", sessionId: item.sessionId });
      return;
    }
    // 工作区那一行：展开 / 收起（面板留着重画，不关）
    if (kind === "workspace" && item.__section === "space") {
      toggleGroupIn(view, item.file);
      return;
    }
    if (view.keepOpen) {
      // 常驻那一列不关，所以不能走“选完就走”那条路（pickerChoice 是“挑好了、结束这次挑”）：
      // 会话直接切过去，目录用那一行自己带过来的（组头的目录）。
      vscode.postMessage({ type: "workspaceOpenSession", path: item.file, cwd: item.cwd || "" });
      return;
    }
    const payload = { file: item.file };
    // 组里那些会话行带着自己的目录（“历史会话”是按工作区分组的）；别的列表没有这一项。
    if (item.cwd) { payload.cwd = item.cwd; }
    hidePicker(view);
    vscode.postMessage({ type: "pickerChoice", kind, payload });
  }

  function cancelPicker(view = modalView) {
    const st = view.state; if (!st) { return; }
    const kind = st.kind;
    // 常驻那一列上那颗叉的意思是“收起”（跟顶条那颗 <<< 一样，并且记住）
    if (view.keepOpen) { collapseSidebar(); return; }
    hidePicker(view);
    vscode.postMessage({ type: "pickerCancel", kind });
  }
  /**
   * “项目与会话”面板：宿主给的是两块（会话 / 工作区），这里拉平成一个数组交给通用渲染。
   * 会话在前、工作区在后；每行记着自己是哪一块（__section），下面渲染分行、
   * 点行为也不一样（点会话关面板切过去，点工作区只换上半）。
   */
  /**
   * 这一块面板现在画的是哪份「项目与会话」状态：头一回收到就现建一份，之后重推一份
   * 只需把宿主给的那两块换上去（工作区行、还有没有下一批）—— 展开了的那几组、
   * 已经取回的会话行都留在手里这份里，换一份新的就等于把下半那一格推倒重来。
   * 浮层里的抽屉与常驻那一列共用这一份拼法（见 paintWorkspacePanel）。
   */
  function updateWorkspacePanelState(view, msg) {
    let st = view.state;
    if (!st || st.kind !== "workspace") {
      st = {
        kind: "workspace",
        // 展开了的那几组会话：目录键 → { items, nextOffset, hasMore, loading, loaded }
        groups: new Map(),
        items: [],
        filtered: [],
        draftModel: null,
        draftThinking: undefined,
        toggle: false,
        // 面板里现在只有工作区那一块会「加载更多」（历史会话那一份在浮层里，另有一套）
        historyHasMore: false,
        historyLoading: false,
        spacesLoading: false,
      };
      view.state = st;
    }
    // 宿主给的工作区行（没动过的原样一份）：组头排序、挂会话都从它算起
    st.spaceItems = workspaceFlatItems(msg);
    st.spacesHasMore = !!(msg.spaces && msg.spaces.hasMore);
    st.current = msg.current || null;
    return st;
  }

  /** 这一块面板收到新数据了：画法跟着它的种类走（「项目与会话」按格画，见 paintWorkspacePanel）。 */
  function repaintPickerPanel(view) {
    if (view.state && view.state.kind === "workspace") { paintWorkspacePanel(view); return; }
    renderPickerItems(view);
  }

  /**
   * 把面板那串行重拼一遍：「正在对话」在前，然后是工作区那一块（展开了的组把会话挂在自己下面）。
   * 会话增减、展开 / 收起、某一组取回了一批——凡是画面要跟着变的都调它。
   * @param fetch 拼到展开的组时要不要去跟宿主要那一组（面板刚建出来、还没有真的那块屏时为 false）
   */
  function rebuildWorkspaceItems(view, fetch) {
    const st = view.state;
    if (!st || st.kind !== "workspace") { return; }
    st.items = openSessionItems().concat(buildSpaceRows(view, fetch !== false));
  }

  /**
   * 工作区那一块的行：当前会话所在那个组排最上面，展开了的组把它的会话行挂在组头下面，
   * 「加载更多」卡在那一组的末尾。
   */
  function buildSpaceRows(view, fetch) {
    const st = view.state;
    const out = [];
    for (const it of withCurrentWorkspaceFirst(st.spaceItems)) {
      out.push(it);
      if (!groupExpanded(it.file)) { continue; }
      const g = groupState(st, it.file);
      // 这一组还没取过（刚展开、或者面板刚重推一份）：现在去要第一条
      if (fetch && !g.loaded && !g.loading) { requestGroupPage(view, it.file, 0); }
      for (const row of g.items) {
        // 不标「当前会话」：这些会话可以同时开着好几个，行尾的「已打开」胶囊已经说明它开着；
        // 画一个“当前”出来，看着像是只能有一个。宿主给的那批里带着 current（它按“这块屏在看哪个”
        // 算的），这里得抹掉，不然画的时候又照它加上了。
        const copy = Object.assign({}, row, {
          __section: "groupSession",
          section: it.section,
          groupPath: it.file,
        });
        delete copy.current;
        out.push(copy);
      }
      if (g.hasMore) { out.push({ __section: "groupMore", section: it.section, groupPath: it.file }); }
    }
    return out;
  }

  /** 某一组的那一摊（展开 / 收起之间留着已经取回的行，再展开就不用等）。 */
  function groupState(st, path) {
    const key = normPathKey(path);
    let g = st.groups.get(key);
    if (!g) {
      g = { items: [], nextOffset: 0, hasMore: false, loading: false, loaded: false };
      st.groups.set(key, g);
    }
    return g;
  }

  // ---- 展开记忆：这台设备上手动展过 / 收过哪些工作区（跟项目与会话侧边栏“收没收起”一个规矩） ----
  const EXPANDED_STORE_KEY = "pichat.workspaceExpanded";
  /** 记住的那一份；null = 这台设备上还没记过（那就只展开当前会话所在的那个）。 */
  let expandedDirs = readExpandedDirs();

  function readExpandedDirs() {
    try {
      const raw = localStorage.getItem(EXPANDED_STORE_KEY);
      if (!raw) { return null; }
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.map((p) => normPathKey(p))) : null;
    } catch {
      return null;
    }
  }

  function rememberExpandedDirs() {
    try { localStorage.setItem(EXPANDED_STORE_KEY, JSON.stringify(Array.from(expandedDirs || []))); } catch { /* 存不了就算了 */ }
  }

  /** 这个工作区现在是展开的吗（没记过时：展开当前会话所在的那个）。 */
  function groupExpanded(path) {
    if (expandedDirs === null) { return samePath(path, activeSessionCwd()); }
    return expandedDirs.has(normPathKey(path));
  }

  /** 点一下组头：展开 / 收起，并把结果记住。 */
  function toggleGroup(path) {
    const key = normPathKey(path);
    if (expandedDirs === null) {
      expandedDirs = new Set();
      const cur = activeSessionCwd();
      if (cur) { expandedDirs.add(normPathKey(cur)); }
    }
    if (expandedDirs.has(key)) { expandedDirs.delete(key); } else { expandedDirs.add(key); }
    rememberExpandedDirs();
  }

  /** 面板里点了一个工作区：展开 / 收起（行尾那颗加号是新建会话，它自己吞掉点击）。 */
  function toggleGroupIn(view, path) {
    const st = view.state;
    if (!st || st.kind !== "workspace") { return; }
    toggleGroup(path);
    rebuildWorkspaceItems(view);
    paintWorkspacePanel(view);
  }

  /**
   * 跟宿主要某一组会话（offset = 从第几个文件接着扫；第一次是 0）。
   * “想找哪个组”按先来后到记一笔，回来的那批从那里认领（跟两颗「加载更多」一个路子）。
   */
  function requestGroupPage(view, path, offset) {
    const st = view.state;
    if (!st || st.kind !== "workspace") { return; }
    const g = groupState(st, path);
    if (g.loading) { return; }
    g.loading = true;
    groupWaits.push({ path: normPathKey(path), view });
    vscode.postMessage({ type: "workspaceSessions", path, offset });
  }

  /** 回来的那一批要交给谁：按先来后到找等它的那块面板。 */
  function takeGroupView(path) {
    const key = normPathKey(path);
    for (let i = 0; i < groupWaits.length; i++) {
      if (groupWaits[i].path === key) { return groupWaits.splice(i, 1)[0].view; }
    }
    return viewShowing("workspace");
  }

  /** 正在等某一组会话的那几笔账（哪块屏要的、要的是哪个目录）。 */
  const groupWaits = [];

  /**
   * 哪一块面板正画着这种内容（浮层那份与常驻那一列各看各的）。
   * 「加载更多」回来的那批靠它找主（另有按先来后到记的账，见 takeLoadMoreView）。
   */
  function viewShowing(kind) {
    if (modalView.state && modalView.state.kind === kind && !modalView.root.classList.contains("hidden")) { return modalView; }
    if (dockView.state && dockView.state.kind === kind) { return dockView; }
    return null;
  }

  function workspaceFlatItems(msg) {
    const sp = (msg.spaces && Array.isArray(msg.spaces.items)) ? msg.spaces.items : [];
    return sp.map((it) => {
      const copy = {};
      for (const k in it) { if (Object.prototype.hasOwnProperty.call(it, k)) { copy[k] = it[k]; } }
      copy.__section = "space";
      copy.section = "工作区";
      return copy;
    });
  }

  function renderPicker(msg, view = null) {
    const kind = msg.kind;
    const toggle = !!msg.toggle;
    // 「项目与会话」画到哪儿：宽窗 + 用户没收起 → 右边那一列（#sidebarDock，见上面“常驻的项目与会话侧边栏”）；
    // 窄窗（手机、窄面板）→ 浮层里那张抽屉。别的拾取器一律画在浮层那份里。
    // 这一下已经收起 / 变窄了就当没收到（不然收起了还弹一张抽屉出来），并告诉宿主别再等着。
    if (view === null) {
      if (kind !== "workspace") {
        view = modalView;
      } else {
        if (msg.dock === true ? !sidebarEnabled() : sidebarWide()) {
          vscode.postMessage({ type: "pickerCancel", kind: "workspace" });
          return;
        }
        view = sidebarEnabled() ? dockView : modalView;
      }
    }
    const toDock = view === dockView;
    // 顶条那颗下拉与面板是同一块地方上的两种界面，浮层那份弹出来就把它收掉；
    // 常驻那一列不算「弹面板」：它平时就一直在右边，而新建 / 关掉一个会话之后宿主都会
    // 推一份过来，顺手把下拉收掉的话，在那清单里关掉一条就没法接着关下一条了
    // （清单自己用的是另一套行，见 refreshSessionMenu）。
    if (!toDock) { closeSessionMenu(); }
    // “项目与会话”面板不放搜索框：上半会话、下半工作区两块结构，这个框帮不上忙还占一截
    // （要找项目看路径就行）；历史面板的搜索留着。
    const searchable = msg.searchable !== false && !toggle && kind !== "workspace";
    // 宿主给的这一半（磁盘上的历史会话 / 工作区）和界面自己拼的「正在对话」合成一份：
    // 之后就只换「正在对话」那一段（见 refreshOpenSessionsInPicker），
    // 免得把「加载更多」追加进来的行弄丢。
    // 历史抽屉里磁盘上那批会话也归成一节（「历史会话」）：没有这一节，它们会并到
    // 「正在对话」底下，看着像是那些开着的会话的续行。
    if (kind === "workspace") {
      // 「项目与会话」那份：浮层里的抽屉与常驻那一列共用这一份拼法（见 updateWorkspacePanelState）
      updateWorkspacePanelState(view, msg);
      // 展开了的那几组现在去要会话（上面那份是没带“哪块屏”拼的，要不出来）
      rebuildWorkspaceItems(view);
    } else {
      const rawHostItems = Array.isArray(msg.items) ? msg.items : [];
      const hostItems = kind === "history"
        ? rawHostItems.map((it) => (it.section ? it : Object.assign({}, it, { section: HISTORY_SECTION })))
        : rawHostItems;
      const openItems = kind === "history" ? openSessionItems() : [];
      view.state = {
        kind,
        items: openItems.concat(hostItems),
        filtered: [],
        current: msg.current || null,
        draftModel: null,
        draftThinking: undefined,
        toggle,
        historyHasMore: msg.hasMore === true,
        historyLoading: false,
        spacesHasMore: false,
        spacesLoading: false,
      };
    }
    // 「正在对话」那一段的指纹不在这里记：renderPickerItems 画完那一格时才记（见 paintWorkspacePanel）。
    // 这里先记一笔的话，重推一份面板时它已经把指纹换成新的了，按格比较就看不出上半变了。
    // 列表刚打开时不预选任何一行：哪条会话是“当前”由行尾那颗胶囊说，预选只会给那一行铺一层灰底，
    // 看着像又选中了一条（这里已经没有键盘那套“选中行”了，开着就等鼠标 / 触摸去点）。
    const titleMap = { model: "切换模型", history: "会话历史", options: "显示选项" };
    view.title.textContent = titleMap[kind] || (typeof msg.title === "string" && msg.title ? msg.title : "选择");
    // 标题下面那行小字（现在只有文件夹选择器用：正在看的是哪个目录）；没有就收起来
    setPickerSubtitle(typeof msg.subtitle === "string" ? msg.subtitle : "", view);
    if (view.search) { view.search.value = ""; }
    if (view.searchWrap) { view.searchWrap.classList.toggle("hidden", !searchable); }
    view.footer.classList.remove("pk-model-footer");
    view.footer.classList.remove("pk-history-footer");
    view.footer.innerHTML = "";
    if (kind === "model") {
      view.footer.classList.remove("hidden");
      // 预选当前模型为 draft（host 已把它排到列表第一位）：打开即高亮（.active）+ 推理强度 / footer 就绪；
      // 没改过（还是当前这个）时底下那颗「确认切换」是灰的，点不动。
      const cur = view.state.items.find((it) => it.current);
      if (cur) {
        view.state.draftModel = cur;
        view.state.draftThinking = defaultThinkingForModel(view.state, cur);
      }
    } else if (kind === "history" || kind === "workspace") {
      // 历史会话 / 项目与会话面板：头部加一颗「收起 / 关闭」按钮（面板占满整屏高，
      // 窄屏幕上遮罩只剩一条缝，点不到），底部留一行「设置」。
      view.footer.classList.remove("hidden");
      view.footer.classList.add("pk-history-footer");
      // 面板重画（切换工作区、追加数据走 renderPicker）不会先过 hidePicker，
      // 头部的关闭按钮是 append 进去的：先把旧的那颗摘掉，不然越摘越多。
      const staleClose = view.root.querySelector(".pk-header-close");
      if (staleClose) { staleClose.remove(); }
      const headerClose = document.createElement("button");
      headerClose.type = "button"; headerClose.className = "pk-header-close";
      // 常驻那一列上它管“收起”（跟顶条那颗 <<< 一回事）；浮层那一套才是“关闭”
      headerClose.title = view.keepOpen ? "收起侧边栏" : "关闭 (Esc)";
      headerClose.setAttribute("aria-label", view.keepOpen ? "收起侧边栏" : "关闭");
      headerClose.innerHTML = ICONS["close-bold"];
      headerClose.addEventListener("click", () => cancelPicker(view));
      view.header.appendChild(headerClose);
      const settingsBtn = document.createElement("button"); settingsBtn.type = "button";
      settingsBtn.className = "secondary pk-footer-settings";
      settingsBtn.title = "打开设置";
      settingsBtn.innerHTML = ICONS.sliders + "<span>设置</span>";
      settingsBtn.addEventListener("click", () => {
        // 常驻那一列不用收（设置浮层盖在它上面，关掉设置它还在原处）；浮层那一套才先收起面板
        if (!view.keepOpen) { cancelPicker(view); }
        openSettings();
      });
      view.footer.appendChild(settingsBtn);
    } else if (toggle) {
      view.footer.classList.remove("hidden");
      const closeBtn = document.createElement("button"); closeBtn.className = "secondary"; closeBtn.textContent = "关闭";
      closeBtn.addEventListener("click", () => cancelPicker(view));
      view.footer.appendChild(closeBtn);
    } else {
      view.footer.classList.add("hidden");
    }
    // 这几颗类（pk-drawer / pk-workspace / pk-folders）是浮层那份渲染时加上去的；
    // 常驻那一列的写在 HTML 里（staticChrome），收起展开都一直是那几颗。
    if (!view.staticChrome) {
      // 历史会话与项目与会话从右侧滑进来（整屏高的面板）；其余拾取器照旧居中弹出
      view.root.classList.toggle("pk-drawer", kind === "history" || kind === "workspace");
      view.root.classList.toggle("pk-workspace", kind === "workspace");
      // 文件夹选择器：不给筛选框那一截地方，列表按资源管理器的密度与排版画
      view.root.classList.toggle("pk-folders", kind === "folders");
      view.root.classList.remove("hidden");
    }
    if (toDock) { sidebarAsked = false; }
    syncSidebarLayout();
    // 「项目与会话」按格画：两格都在时只动真的变了的那一格（见 paintWorkspacePanel）；其余面板整份画
    if (kind === "workspace") { paintWorkspacePanel(view); } else { renderPickerItems(view); }
    // 计时：若宿主回显了 t0，输出点击 → picker 可见的往返耗时（多 panel 卡顿排查用）
    if (typeof msg.t0 === "number") {
      console.log("[pi] picker(" + kind + ") 点击→弹出: " + Math.round(performance.now() - msg.t0) + "ms");
    }
    if (searchable && view.search) { setTimeout(() => view.search.focus(), 0); }
  }
  // 点遮罩收起来：只管浮层那份（常驻那一列不靠点外面收：它不是浮层，那颗 <<< 与面板里那颗叉才管收）
  modalView.root.addEventListener("click", (e) => {
    if (e.target === modalView.root) { cancelPicker(modalView); }
  });
  modalView.search.addEventListener("input", () => {
    if (!modalView.state) { return; }
    renderPickerItems(modalView);
  });
  // 浮层的列表只用鼠标 / 触摸点：没有「方向键上下选行、回车打开那一行」那一套，
  // 「切换模型」那层里的左右键换推理档位也一并去了。这里只剩 Esc：收回这一层。
  // 收之前得先把这条按键就地处掉：后面那个 document 上的监听会用 Esc 中止正在生成的那一轮，
  // 它开头那句“浮层开着就跳开”的判断这会儿已经被 cancelPicker 改掉了
  // （两个监听都在 document 上，按注册顺序跑，靠 stopImmediatePropagation 拦下来才管用）。
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !pickerModalOpen()) { return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelPicker(modalView);
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
    if (a) {
      e.preventDefault();
      // 浏览器页面里开左边那一列看文件（后端自己读）；插件里的对话面板里照旧交给编辑器打开
      openFileForUser(a.getAttribute("data-file"),
        a.dataset.line ? parseInt(a.dataset.line, 10) : undefined,
        a.dataset.col ? parseInt(a.dataset.col, 10) : undefined,
        a.getAttribute("data-dir") === "1");
      return;
    }
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

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") { return; }
    if (pickerModalOpen()) { return; }
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
      if (pickerModalOpen()) { return; }
      // 清单开着也一样：这条键归那张清单（收回它），别顺手把正在生成的那一轮中止了
      if (saidOpen()) { return; }
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
    // 这一轮跑完：还在留的那条位置到此为止（一轮里最后调的是工具、后面没再出正文时，就靠这一下收）
    if (!on) { endRunningLine(st); }
    if (activeId === st.id) { updateSendState(); syncStatus(); }
    renderSessionBar();
    syncPaneStatuses();
    syncEndHint(st);
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
    syncEndHint(st);
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
        // 这一批状态是权威的（重连 / 刷新 / 别的窗口动过）：末尾那颗胶囊跟着重算一次
        syncEndHint(st);
        // 整屏重画收尾也走这儿：重放出来末尾那颗「补来的思考」跟当场生成时一样并回去
        foldTailThinking(st);
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
      // 会话目录这时候才认识：这一列开着又空着的话，把「项目目录」那一格摆上（见票 13）
      ensureProjectDirTab();
      updateSendState();
      syncStatus();
      refreshOpenSessionsInPicker();
      // 常驻的项目与会话侧边栏在这一批会话到了之后才要内容：不然上半那份「正在对话」是空的
      ensureSidebarPanel();
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
      const view = takeLoadMoreView("sessions", ["history", "workspace"]);
      const st = view ? view.state : null;
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
        repaintPickerPanel(view);
      }
      return;
    }
    if (type === "historyPageEnd") {
      const view = takeLoadMoreView("sessions", ["history", "workspace"]);
      const st = view ? view.state : null;
      if (st && (st.kind === "history" || st.kind === "workspace")) {
        st.historyLoading = false;
        repaintPickerPanel(view);
      }
      return;
    }
    if (type === "workspacePageAppend") {
      // 工作区那一块的下一批（点「加载更多」时走这里）；接在已有的工作区行后面。
      const view = takeLoadMoreView("spaces", ["workspace"]);
      const st = view ? view.state : null;
      if (st && st.kind === "workspace") {
        const more = (Array.isArray(msg.items) ? msg.items : []).map((it) => {
          const copy = {};
          for (const k in it) { if (Object.prototype.hasOwnProperty.call(it, k)) { copy[k] = it[k]; } }
          copy.__section = "space";
          copy.section = "工作区";
          return copy;
        });
        st.spaceItems = st.spaceItems.concat(more);
        st.spacesHasMore = msg.hasMore === true;
        st.spacesLoading = false;
        rebuildWorkspaceItems(view);
        repaintPickerPanel(view);
      }
      return;
    }
    if (type === "workspaceSessionsPage") {
      // 某一个工作区那一组会话回来了（展开时 / 点那一组的「加载更多」时）：挂到那一组下面。
      const view = takeGroupView(msg.path);
      const st = view ? view.state : null;
      if (st && st.kind === "workspace") {
        const g = groupState(st, msg.path);
        const rows = Array.isArray(msg.items) ? msg.items : [];
        g.items = msg.offset > 0 ? g.items.concat(rows) : rows.slice();
        g.nextOffset = typeof msg.nextOffset === "number" ? msg.nextOffset : g.nextOffset;
        g.hasMore = msg.hasMore === true;
        g.loading = false;
        g.loaded = true;
        rebuildWorkspaceItems(view);
        repaintPickerPanel(view);
      }
      return;
    }
    if (type === "openSettings") { openSettings(); return; }
    if (type === "viewOptionItems") { viewOptionItems = Array.isArray(msg.items) ? msg.items : []; renderViewOpts(); return; }
    if (type === "focusInput") { setTimeout(function () { inputEl.focus(); }, 0); return; }
    // 宿主（VSCode 的命令入口，比如"发送选中文本"）替用户发一条：当作他打进输入框的，
    // 走同一条路（会话还没就绪就先留着、就绪了自动补发）
    if (type === "sendFromHost") { sendFromHost(msg.text); return; }
    // 宿主在某个会话跑完一轮时下发的消息（所有会话都会收到，带 sessionId）：发一条系统通知，
    // 你没在看那个会话就把它标成“有新消息”。子会话（别人派出去干活的）不提醒：它的结果会交回
    // 派它的那个会话，那边跑完自会提醒；子会话缩进挂在父会话下面，标了反而多一颗点。
    // 是不是子会话由后端算（child）：子会话跑完常常紧接着就被关掉，这边按会话列表里的
    // parentId 判会赶不上——那时它的壳已经不在了。
    if (type === "turnEnd") {
      if (msg.child === true) { return; }
      notifyTurnEndFor(msg.sessionId, msg.status, msg.text);
      const done = msg.sessionId ? sessions.get(msg.sessionId) : null;
      if (done && done.id !== activeId) {
        markSessionUnread(done);
      }
      return;
    }
    // 模型在某个会话里问了一道选择题（ask_choice）、正等着人答：同一条路由（每块屏都收到）。
    // 卡片只长给“正看着那个会话”的屏（切过去时会补上），这条提醒发出去，人在别处也看得见。
    if (type === "askWaiting") { notifyAskFor(msg.sessionId, msg.text); return; }
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
      // 不能整段重画 .md（那会把已经挂好的符号链接抹掉，见 applySymbolLinks）。
      // 正在流式的那条消息跳过：它收尾时会自己挂一次（见 finalizeCurrentAssistant）。
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
        // 新的一段对话开始：先把上一段末尾那颗（如果有）并回去，本段的 think 再从头算
        foldTailThinking(t);
        t.segmentThinking = null;
        const label = msg.imageCount ? "[" + msg.imageCount + " 张图片] " : "";
        addPlain(t, "user", "你", label + (msg.text || ""));
        endThinking(t, "");
        scrollToBottom(t, true);
        // 刚发出去的这条把末尾那颗胶囊挤到了前头：重算一次（生成中会换成「卡住了」）
        syncEndHint(t);
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
        // 这一轮跑到这儿就停了：末尾要是还挂着一颗「补来的思考」，并回本段那颗
        foldTailThinking(t);
        // 跑完的提醒改由宿主在“一轮真正结束”时下发 turnEnd 消息（见 notifyTurnEndFor），
        // 这里不再对当前会话单独出声。
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
        t.endHintEl = null;   // 消息流末尾那颗「继续」/「卡住了」也随重画一起没了（引用跟着丢，见 syncEndHint）
        t.endHintRow = null;
        t.endHintStopEl = null;
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
        t.segmentThinking = null;
        t.tailThinking = null;
        t.currentToolRow = null;
        dropRunningLine(t);   // 这条连着窗格一起没了（上面的 innerHTML 已经清掉它）；定时器也一并清
        t.toolGroups = null;
        t.toolGroupEntries.clear();
        t.pendingToolCards.clear();
        for (const tg of t.pendingToolTags.values()) { clearInterval(tg._timer); }
        t.pendingToolTags.clear();
        // 流里的问话卡片也随重画一起没：还等着的那几张由宿主重发（见 resendCardsTo）
        t.askCards.clear();
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
        // 重画后窗格是空的（重放的消息随后一批批进来）：这颗胶囊按当前状态先收着，
        // 真有对话的话等重放完那一批（historyBatchEnd）或本轮结束（streamEnd）再露面。
        syncEndHint(t);
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
            syncGroupTag(t, groupEntry.group);
            scrollToBottom(t);
          }
          break;
        }
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl.classList.remove("running");
          syncRunningLine(t);   // 这条不跑了：末尾那行跟着少一条
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
            mountToolImageBlock(t, { toolName: tagEl._toolName, argStr: tagEl._argStr, tipCall: tagEl._tipCall, toolCallId: msg.toolCallId }, msg.images);
          } else {
            setTagTip(tagEl, tagEl._resultText, "");
          }
        }
        break;
      }
      case "resultImage": {
        // 点开的那张图回来了：把占位换成真图（同一张占位可能有好几处：重画过、或还在暂存区里）
        const key = imageKey(msg.toolCallId, typeof msg.index === "number" ? msg.index : 0);
        const chips = Array.from(document.querySelectorAll("[data-result-img]"))
          .filter((el) => el.getAttribute("data-result-img") === key);
        const data = typeof msg.data === "string" ? msg.data : "";
        for (const chip of chips) {
          if (!data) {
            chip.disabled = true;
            chip.textContent = typeof msg.error === "string" && msg.error ? msg.error : "这张图取不到了";
            continue;
          }
          const card = chip.closest(".tool-image-block") || chip.parentElement;
          chip.replaceWith(resultImageEl({ data: data, mimeType: msg.mimeType }, card));
        }
        break;
      }
      case "askCard":
        // 问话卡片（模型问的选择题、扩展问的确认 / 输入 / 选一个）：长在这个会话的消息流里
        renderAskCard(t, msg);
        break;
      case "askCardDone":
        // 这张卡片收尾了（自己答的 / 别的屏答的 / 到点没答）：定住并写上一行结果
        settleAskCard(t, String(msg.id || ""), msg.answer || null);
        break;
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
        const savedProgrammaticTop = t.programmaticTop;
        const savedSegmentThink = t.segmentThinking;   // 暂存区自己算自己的，别动本段那颗与末尾候选
        const savedTailThink = t.tailThinking;
        t.paneEl = t._stage;
        try { applyPanelMessage(inner); }
        finally {
          t.paneEl = realPane;
          t.segmentThinking = savedSegmentThink;
          t.tailThinking = savedTailThink;
          // 渲染进暂存区时的滚动状态调整（scrollToBottom 等）不该影响真实窗格
          t.stickToBottom = savedStick;
          t.programmaticScroll = savedProgrammatic;
          t.programmaticTop = savedProgrammaticTop;
        }
        break;
      }
      case "historyBatchEnd":
        flushHistoryBatch(t, msg.hasMore === true, typeof msg.hidden === "number" ? msg.hidden : 0);
        // 历史补完：末尾那颗胶囊重新算一次（补进来的老消息在顶上，不影响它）
        syncEndHint(t);
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
   * 并把滚动位置补回去，让视野还停在原来那几条消息上。
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
    // 插到哪儿：顶部那个「加载更早」按钮还在就插在它后面；已经收掉了（这是最后一批）就插在最前面
    const btn = t._historyBtn && t._historyBtn.parentNode === pane ? t._historyBtn : null;
    const at = btn ? btn.nextSibling : pane.firstChild;
    // 尺子：插入点后面那条老消息 —— 插进去的东西全长在它前面，它往下挪了多少就补多少，
    // 不按“插入那一刻长高了多少”算：那批里的图片、代码高亮会晚一步才把高度撑起来，
    // 按高度差算就少补那么一点（几十像素），视野看着就往下跑（见 dev/historyScroll.js）。
    const mark = btn ? btn.nextElementSibling : pane.firstElementChild;
    let markTop = mark ? mark.offsetTop : 0;
    const beforeHeight = pane.scrollHeight;
    // 这一下由我们自己补滚动位置：先把浏览器的滚动锚定临时关掉，
    // 它也会因为“上方变高”补一次，两边叠起来视野就被推下去一整批的高度。
    const prevAnchorStyle = pane.style.overflowAnchor;
    pane.style.overflowAnchor = "none";
    while (stage.firstChild) { pane.insertBefore(stage.firstChild, at); }
    const grew = pane.scrollHeight - beforeHeight;
    let grewLeft = grew;
    const putBack = () => {
      if (!pane.isConnected) { return; }
      if (mark && mark.parentNode === pane) {
        // 只补「上一次看它到现在」那一段：这函数要跑好几帧，每次都用累计差会补成好几倍
        const top = mark.offsetTop;
        pane.scrollTop += top - markTop;
        markTop = top;
      } else if (grewLeft) {
        // 尺子没了（窗格没挂在页面上、那一行被换掉）：退回按高度差补，也只补这一回
        pane.scrollTop += grewLeft;
        grewLeft = 0;
      }
    };
    putBack();
    // 后到的高度（图片解码、高亮重排）会让它再跑一点：再对两帧位置，然后把滚动锚定还给浏览器
    let frames = mark && pane.isConnected ? 2 : 0;
    const settle = () => {
      putBack();
      frames--;
      if (frames > 0) { requestAnimationFrame(settle); return; }
      pane.style.overflowAnchor = prevAnchorStyle;
    };
    if (frames > 0) { requestAnimationFrame(settle); } else { pane.style.overflowAnchor = prevAnchorStyle; }
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
        const desc = viewOptionDesc(it);
        if (desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = desc; txt.appendChild(d); }
        row.appendChild(check); row.appendChild(txt);
        row.addEventListener("click", () => {
          // 通知这一项：点它多半是想开通知，顺便问一次浏览器权限（用户点了一下，正好是有手势的时候）
          if (it.action === "notifyTurnEnd") { askNotifyPermission(); }
          vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: it.value });
        });
      }
      viewOptsRoot.appendChild(row);
    });
  }

  /** 一行设置的说明。与设备相关的（发通知）跟一句本机的真实情况：能不能发、要不要先问权限。 */
  function viewOptionDesc(it) {
    const desc = it.desc || "";
    if (it.action !== "notifyTurnEnd") { return desc; }
    const note = notifyUnavailableNote();
    return note ? desc + "（" + note + "）" : desc;
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

  // 常驻的项目与会话侧边栏：摆好版面（宽窗且没收起 → 右边留出那一列），把开关接口交给顶条那颗 <<<。
  // 面板内容不在这一步要：等宿主把会话列表送来再要（见 sessionList 那段里的 ensureSidebarPanel）。
  window.pichatSidebar = { toggle: toggleSidebar };
  syncSidebarLayout();

  vscode.postMessage({ type: "ready" });
})();
