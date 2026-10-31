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
  const messagesEl = document.getElementById("messages"); // 容器，内含各 .session-pane
  const jumpBottomBtn = document.getElementById("jumpBottom");
  // VSCode 官方 codicon 的 chevron-right 折线图标（从 @vscode/codicons 包取出）。
  // 各处折叠小三角用同一份：画的是朝右，展开时靠 CSS transform 转成朝下。
  const CHEVRON_SVG =
    '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">' +
    '<path d="M6.14601 3.14579C5.95101 3.34079 5.95101 3.65779 6.14601 3.85279L10.292 7.99879L6.14601 12.1448C5.95101 12.3398 5.95101 12.6568 6.14601 12.8518C6.34101 13.0468 6.65801 13.0468 6.85301 12.8518L11.353 8.35179C11.548 8.15679 11.548 7.83979 11.353 7.64478L6.85301 3.14479C6.65801 2.94979 6.34101 2.95079 6.14601 3.14579Z"/></svg>';
  // 文件搜索那颗放大镜：细笔画，跟浏览器桥里那几颗手画图标同一个调子（codicon 里没有细笔画版）。
  const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3 14 14" stroke-linecap="round"/></svg>';
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
    // 加号：面板里「在新工作区新建会话」那一行用（跟输入框底下那颗新建会话同一颗图标）。
    add: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M8 1.5C8 1.22386 7.77614 1 7.5 1C7.22386 1 7 1.22386 7 1.5V7H1.5C1.22386 7 1 7.22386 1 7.5C1 7.77614 1.22386 8 1.5 8H7V13.5C7 13.7761 7.22386 14 7.5 14C7.77614 14 8 13.7761 8 13.5V8H13.5C13.7761 8 14 7.77614 14 7.5C14 7.22386 13.7761 7 13.5 7H8V1.5Z"/></svg>',
    sliders: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 4.5h6.2M11.8 4.5H14M2 11.5h1.7M7.3 11.5H14"/><circle cx="10" cy="4.5" r="1.8"/><circle cx="5.5" cy="11.5" r="1.8"/></svg>',
    // 三根高低不一的柱子：侧边栏底部那颗「统计」（工具调用耗时）用它。
    chart: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><rect x="2" y="9" width="3" height="5" rx="0.6"/><rect x="6.5" y="5" width="3" height="9" rx="0.6"/><rect x="11" y="2" width="3" height="12" rx="0.6"/></svg>',
    // 一只箱子（工具箱）：侧边栏底部那颗「工具」（这个会话加载了什么）用它。
    // 描边的，跟上面那颗实心柱子摆在一起能分得开。
    tools: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.2 5.4h11.6a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.2a1 1 0 0 1-1-1V6.4a1 1 0 0 1 1-1Z"/><path d="M6 5.4V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.4"/><path d="M1.2 9.2h13.6"/></svg>',
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
    // 播放三角 / 暂停两根竖条：目标条展开里那颗「开始 ⇄ 暂停」的按钮用
    play: '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path d="M5 3.1v9.8c0 .5.55.81.98.53l7.3-4.9a.63.63 0 0 0 0-1.06l-7.3-4.9A.63.63 0 0 0 5 3.1Z"/></svg>',
    pause: '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><rect x="3.6" y="2.6" width="3.2" height="10.8" rx="0.8"/><rect x="9.2" y="2.6" width="3.2" height="10.8" rx="0.8"/></svg>',
    // 停止小方块：跟上面两颗一样大（12px），不然它看着比暂停粗一圈
    "stop-small": '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2"/></svg>',
    // 三条横线：输入框右边那颗「你说过的话」（一句话一行，所以是清单）。
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
  // 一个会话都没有时消息流中间那块提示（见 syncNoSessionHint）
  const noSessionHintEl = document.getElementById("noSessionHint");
  // 输入框底下那条小横排：左边是模型胶囊（model chip），右边是「你说过的话」那颗按钮。
  const ctxIconEl = document.getElementById("ctxIcon");
  // 顶条中间那一块（装着那一排会话格）：清单贴着当前那一格掉出来，点别处收起
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
  // 顶条中间那一排会话格（见下面 renderSessionTabs）：一格一个主会话，点一下切过去。
  const sessionTabRow = document.getElementById("sessionTabs");
  // 右边那颗 ▾：掉出清单，列的只是摆不下、被藏起来的那几格（全摆得下时它不露面）。
  // 画的还是那份 chevron（画的是朝右），转 90° 成朝下（见 chat.css 的 #sessionMore）。
  const sessionCaret = document.createElement("button");
  sessionCaret.type = "button";
  sessionCaret.id = "sessionMore";
  sessionCaret.className = "hidden";
  sessionCaret.title = "摆不下的会话";
  sessionCaret.setAttribute("aria-label", "摆不下的会话");
  sessionCaret.innerHTML = CHEVRON_SVG;
  sessionCaret.addEventListener("click", (e) => { e.stopPropagation(); toggleSessionMenu(); });
  sessionTabRow.appendChild(sessionCaret);
  // 一个会话都没有时不掉清单（里头什么都没有）：去把「项目与会话」摊开，那里才有东西可挑。
  sessionTabRow.addEventListener("click", () => {
    if (!activeSession()) { openWorkspaceForEmpty(); }
  });
  // （会话跑在哪个目录不上顶条：一排格子已经够挤，完整路径放在每格的悬停提示里。）
  // 格与格之间那个间距（量摆设时用，跟 chat.css 里 #sessionTabs 的 gap 一个数）
  const TAB_GAP = 4;
  // 那一排的宽度一变（窗口、左边那一列、右边那一列）就重摆一次：放得下几个就放几个。
  // 摆出来的东西不改那一排自己的宽度，所以不会来回打转。
  // ▾ 那张清单列的就是“被藏起来的那几格”：宽度一变那个集合就变了，开着的那张跟着重画。
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { layoutSessionTabs(); refreshSessionMenu(); }).observe(sessionTabRow);
  }

  // ---- 会话本地状态（后端 sessionList 消息驱动）----
  // sessions：一个会话一份状态（消息窗格 + 名字 / 状态 / 父子关系）。
  // 一次只看一个会话：activeId 就是当前这个，其余会话的 DOM 留在内存里，切回去接着看。
  const sessions = new Map();        // sessionId -> state
  const sessionDrafts = new Map();   // sessionId -> { text, selStart, selEnd, height }（输入草稿按会话存）
  let sessionOrder = [];             // 后端给的会话顺序（列表段按它画）
  let activeId = null;               // 当前显示的会话 id
  // 后端说“你这块屏切到这个会话”但那个会话的壳还没建出来（列表在路上）：记下来等它到了一起用
  let pendingActivateId = null;
  // 会话列表里点过“关闭”的那一行：等第二次点击确认（几秒后自动撤销，防误触）。
  // 只有会话正在跑的时候才会走到这儿（跑完了点一下就关，不用问，见 askCloseSession）。
  let pendingCloseId = null;
  let pendingCloseTimer = null;
  // 手机上左右划切会话（见下文“左右划”那段）：这一段拖动的状态、松手后等后端回话的那一趟
  let swipe = null;
  let pendingSlide = null;

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
    panel: document.getElementById("pickerPanel"),
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
    panel: document.getElementById("dockPanel"),
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
  // 必须把 marked.defaults 一起带上：`marked.parse` 自己会合一遍默认值（所以整段渲染那条路
  // 认得文件链接、符号链接、高亮），而 `marked.lexer` / `marked.parser` 不会——按块渲染那条路
  // 只递这份选项，不带 extensions 与 renderer 的话：切块时压根不把路径切成链接，画的时候也没有
  // 那几条 renderer，流式出来的正文里就一个文件链接都没有（刷新页面走重放才有）。
  function mdOptions() { return Object.assign({}, marked.defaults, { breaks: true, gfm: true }); }
  function renderMarkdown(source) { ensureMarkedHighlight(); ensureFileLink(); return marked.parse(source, mdOptions()); }

  /**
   * 正文里的图片：接上后端那条只读地址，让 `<img>` 真取得到。
   *
   * 不接的话浏览器按页面地址去解析相对路径（`/示例图片.png`），后端没有那条地址。两种接法：
   *   - 会话目录里的相对路径（`img/a.png`、`./a.png`）→ `/site/<会话>/<路径>`（路径就在地址里）；
   *   - 整机上的任何路径（`C:\…\x.png`、`/home/…/x.png`、`file:///…`、跳出会话目录的 `..`）
   *     → `/file?anywhere=1`：后端那条放宽了目录边界、但只认图片。
   * 外站地址（`https://…`）与 `data:` / `blob:` 原样留着不动：页面不往外站发请求（见 pageHtml.ts 的 img-src）。
   * 地址是 marked 编码过的（cleanUrl 走 encodeURI），所以先解回路径再重新编码一次。
   * 插件里的对话面板没有这两条地址（那边页面是 vscode-webview 源、安全策略只放行 data:/blob:），照旧不显示。
   * @param baseDir 这些路径从哪个子目录算起（文件侧边栏那份 markdown 文档按它自己所在的那一层算，
   *                消息正文就是会话目录自己，给空串）
   */
  function fixMdImages(root, sessionId, baseDir) {
    if (!root || IN_WEBVIEW || !sessionId) { return; }
    const base = baseDir ? String(baseDir).replace(/\/$/, "") + "/" : "";
    for (const el of root.querySelectorAll("img")) {
      const target = mdImageTarget(el.getAttribute("src") || "", base);
      if (!target) { continue; }
      el.setAttribute("src", target.site !== undefined
        ? "/site/" + encodeURIComponent(sessionId) + "/" + base + target.site
        : "/file?session=" + encodeURIComponent(sessionId) + "&anywhere=1&path=" + encodeURIComponent(target.anywhere));
    }
  }

  /**
   * 图片地址该从哪儿取：`{ site }` 是会话目录里的相对路径（去 `./` 的写法），
   * `{ anywhere }` 是整机上的路径（绝对路径、`file://`、跳出会话目录的 `..`），
   * 取不了（外站、`data:`、`blob:` 这些）给 null，原样留着不动。
   * @param base markdown 文档自己所在的那一层（带尾斜杠）；`..` 这种相对写法要接在它后面
   */
  function mdImageTarget(src, base) {
    let p = String(src || "").trim();
    if (!p) { return null; }
    try { p = decodeURIComponent(p); } catch (e) { /* 解不开就按原样用 */ }
    p = p.replace(/\\/g, "/");
    // 本机文件地址（`file:///C:/…`、`file:///home/…`）：剥掉协议头当路径用
    if (/^file:\/\//i.test(p)) {
      p = p.slice("file://".length);
      if (/^\/[A-Za-z]:\//.test(p)) { p = p.slice(1); }     // file:///C:/… 的那个斜杠
    } else if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(p)) {
      return null;                                          // data: / blob: / http: 与外站（盘符"C:"不算：只有一个字符）
    }
    if (!p) { return null; }
    // 绝对路径：`/home/…`、`C:/…`（Windows 上也有光写 `\\server\share` 的，归一化后是 `//server`）
    const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
    let rel = p;
    while (rel.startsWith("./")) { rel = rel.slice(2); }
    if (!absolute && rel !== ".." && !rel.startsWith("../")) {
      return rel ? { site: rel } : null;
    }
    return { anywhere: absolute || !base ? p : base + p };
  }

  // ==================== mermaid 图 ====================
  // ```mermaid 代码块画成图（media/pele.js：按 Mermaid 12.1 的语法画，同步出 SVG 字符串，不碰 DOM）。
  // 它有 700 多 KB，所以不排进首屏：头一次真出现 ```mermaid 时才照页面 head 里那张纸条去拉
  //（地址见 pageHtml.ts 的 pichat-lazy-scripts；面板里那个脚本本来是内联的，一加载就在，不用拉）。
  // 画不出来的（语法错、认不出是哪种图）把代码块原样留着、底下加一行说明——
  // 不把“画不出来”装成“没有图”。
  // 流式里只在块定型之后才画（见 syncStreamBlocks / finalizeCurrentAssistant）：
  // 半截源码画出来是残图，下一帧又变，闪得厉害。

  /** 画图那个脚本叫什么：清单里它是 lazy-script 那一条（见 src/chatUiFiles.ts）。 */
  const MERMAID_SCRIPT = "pele.js";
  /** 画图那个脚本现在到哪一步了：idle（还没人要用）/ loading（正在拉）/ ready（能用）/ failed（拉不到）。 */
  let mermaidLibState = "idle";
  /** 脚本还在路上、图已经等着的那些正文节点（拉回来之后回头再画一遍）。 */
  const mermaidWaiting = new Set();
  const MERMAID_CACHE = new Map();
  const MERMAID_CACHE_MAX = 60;

  /** 这个代码块是不是 ```mermaid。marked 给的类名是 language-mermaid（走高亮那条路会再加个 hljs）。 */
  function isMermaidBlock(code) {
    return !!code.parentElement && code.parentElement.tagName === "PRE" &&
      /(^|\s)language-mermaid(\s|$)/i.test(code.className || "");
  }

  /**
   * 画图的脚本到了没：到了给 true，没到给 false（顺便开始拉）。
   * 面板里那个脚本是内联的，第一次问就是 true；浏览器页面里第一次问会去拉，拉回来再画等着的那几张。
   */
  function ensureMermaidLib() {
    if (globalThis.pele) { mermaidLibState = "ready"; return true; }
    if (mermaidLibState === "idle") { loadMermaidLib(); }
    return false;
  }

  /** 照 head 里那张纸条（pichat-lazy-scripts）插一个 <script>；同一时间只拉一次。 */
  function loadMermaidLib() {
    mermaidLibState = "loading";
    let url = "";
    try {
      const meta = document.querySelector('meta[name="pichat-lazy-scripts"]');
      const map = JSON.parse((meta && meta.getAttribute("content")) || "{}") || {};
      url = typeof map[MERMAID_SCRIPT] === "string" ? map[MERMAID_SCRIPT] : "";
    } catch (e) { url = ""; }
    // 纸条上没有这条（老后端给的页面）：当拉不到
    if (!url) { mermaidLibFailed(); return; }
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => {
      if (!globalThis.pele) { mermaidLibFailed(); return; }
      mermaidLibState = "ready";
      // 等着的那几张：现在画（这些节点可能已经被换掉了，画了也不显示，但也就这一下）
      for (const root of mermaidWaiting) { decorateMermaid(root); }
      mermaidWaiting.clear();
    };
    script.onerror = () => { mermaidLibFailed(); };
    document.head.appendChild(script);
  }

  /** 拉不到：等着的那些各补一行说明，别一直空着。 */
  function mermaidLibFailed() {
    mermaidLibState = "failed";
    for (const root of mermaidWaiting) { decorateMermaid(root); }
    mermaidWaiting.clear();
  }

  /**
   * 一段 mermaid 源码 → SVG 字符串；画不出来给 { error }。同一段源码只算一次。
   * @param font 上面说的字体（字号跟着界面设置走：框的宽高是按这个字号量出来的）
   * @param maxWidth 正文这一块能用的宽度（0 = 量不到，让库自己按内容排）
   */
  function mermaidSvg(source, font, maxWidth) {
    const key = font.key + "|" + maxWidth + "\n" + source;
    const hit = MERMAID_CACHE.get(key);
    if (hit !== undefined) { return hit; }
    let out;
    try {
      const options = { fontFamily: font.family, fontSize: font.size };
      if (maxWidth > 0) { options.maxWidth = maxWidth; }   // 宽了先按这一块的宽度重排，别把字缩成一点点
      const got = globalThis.pele.render(source, options) || {};
      out = got.svg && Number(got.width) > 0 && Number(got.height) > 0
        ? String(got.svg)
        : { error: "没画出来（这张图算不出大小）" };
    } catch (err) {
      out = { error: mermaidErrorText(err) };
    }
    if (MERMAID_CACHE.size >= MERMAID_CACHE_MAX) { MERMAID_CACHE.clear(); }
    MERMAID_CACHE.set(key, out);
    return out;
  }

  /**
   * 画不出来时底下那行话：认不出哪种图单独说一句，其余照库自己那句（它自己带着“第几行”）——
   * 流程图的那些行号库算得不一定准（会偏一两行），我们不去改它，免得更错。
   */
  function mermaidErrorText(err) {
    if (err && err.code === "unsupported-diagram") {
      return "没画出来：认不出这是哪种图（Mermaid 12 里没有它）";
    }
    const msg = String((err && err.message) || err || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return "没画出来：" + (msg || "这张图的写法有毛病");
  }

  /** 画图用的字体：字号跟着界面的字号设置走（见 applyFontSize），量出来的框宽才对得上画出来的字。 */
  function mermaidFont(root) {
    const cs = getComputedStyle(root);
    const family = cs.fontFamily || "sans-serif";
    const size = parseFloat(cs.fontSize) || 13;
    return { family: family, size: size, key: family + "|" + size };
  }

  /**
   * 把 root 里还没画的 ```mermaid 代码块换成图。重放、重画会再走一遍这里，画过的跳过
   * （画过的 pre 已经不在了）；画不出来的留着代码块，后面补一行说明。
   */
  function decorateMermaid(root) {
    if (!root || !root.querySelectorAll) { return; }
    const blocks = [];
    for (const code of root.querySelectorAll("pre > code")) {
      if (isMermaidBlock(code)) { blocks.push(code); }
    }
    if (blocks.length === 0) { return; }   // 这一块里没有 mermaid：不用去拉那个脚本
    if (!ensureMermaidLib()) {
      // 还在路上就先等着（脚本到了会回头再画一遍）；拉不到就各补一行说明
      if (mermaidLibState === "failed") {
        for (const code of blocks) { showMermaidNote(code, "没画出来：画图那个脚本没拉下来（刷新页面试试）"); }
      } else {
        mermaidWaiting.add(root);
      }
      return;
    }
    const font = mermaidFont(root);
    const width = Math.round(root.getBoundingClientRect ? root.getBoundingClientRect().width : 0) || 0;
    for (const code of blocks) {
      const pre = code.parentElement;
      const source = code.textContent || "";
      if (!source.trim()) { continue; }
      const out = mermaidSvg(source, font, width);
      if (typeof out === "string") {
        const box = document.createElement("div");
        box.className = "md-mermaid";
        box.innerHTML = out;
        pre.replaceWith(box);
      } else {
        showMermaidNote(code, out.error);
      }
    }
  }

  /** 画不出来时在代码块底下补一行说明（已经有了就改那行字，不叠第二行）。 */
  function showMermaidNote(code, text) {
    const pre = code.parentElement;
    if (!pre) { return; }
    const next = pre.nextElementSibling;
    if (next && next.classList && next.classList.contains("md-mermaid-note")) {
      next.textContent = text;
      return;
    }
    const note = document.createElement("div");
    note.className = "md-mermaid-note";
    note.textContent = text;
    pre.after(note);
  }

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

  // 工具那颗齿轮：VS Code 官方图标集（@vscode/codicons）里的 gear，实心的。
  // 小尺寸下比原来那颗描边齿轮干净得多：这个图标在界面上只有 1em（十来像素），
  // 描边版每根线不到一个像素，八颗小牙糊成一个毛边小圈。
  const GEAR_SVG = '<span class="tool-icon"><svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M7.99997 6C6.89497 6 5.99997 6.895 5.99997 8C5.99997 9.105 6.89497 10 7.99997 10C9.10497 10 9.99997 9.105 9.99997 8C9.99997 6.895 9.10497 6 7.99997 6ZM7.99997 9C7.44797 9 6.99997 8.552 6.99997 8C6.99997 7.448 7.44797 7 7.99997 7C8.55197 7 8.99997 7.448 8.99997 8C8.99997 8.552 8.55197 9 7.99997 9ZM14.565 9.715L13.279 8.628C13.245 8.599 13.213 8.567 13.184 8.533C12.888 8.186 12.931 7.667 13.279 7.372L14.565 6.285C14.693 6.177 14.742 6.003 14.691 5.844C14.386 4.903 13.882 4.04 13.219 3.308C13.139 3.22 13.027 3.172 12.912 3.172C12.865 3.172 12.818 3.18 12.773 3.196L11.186 3.761C11.144 3.776 11.1 3.788 11.056 3.796C11.006 3.805 10.956 3.81 10.907 3.81C10.515 3.81 10.167 3.532 10.094 3.134L9.79097 1.482C9.76097 1.318 9.63397 1.188 9.46997 1.153C8.98997 1.051 8.49897 1 8.00097 1C7.50297 1 7.01097 1.052 6.53097 1.153C6.36697 1.188 6.23997 1.318 6.20997 1.482L5.90797 3.134C5.89997 3.178 5.88797 3.221 5.87297 3.263C5.75197 3.6 5.43397 3.81 5.09397 3.81C5.00197 3.81 4.90797 3.794 4.81597 3.762L3.22897 3.197C3.18397 3.181 3.13597 3.173 3.08997 3.173C2.97497 3.173 2.86297 3.221 2.78297 3.309C2.11897 4.041 1.61597 4.904 1.30997 5.845C1.25797 6.004 1.30797 6.178 1.43597 6.286L2.72197 7.373C2.75597 7.402 2.78797 7.434 2.81697 7.468C3.11297 7.815 3.06997 8.334 2.72197 8.629L1.43597 9.716C1.30797 9.824 1.25897 9.998 1.30997 10.157C1.61497 11.098 2.11897 11.961 2.78297 12.693C2.86297 12.781 2.97497 12.829 3.08997 12.829C3.13697 12.829 3.18397 12.821 3.22897 12.805L4.81597 12.24C4.85797 12.225 4.90197 12.213 4.94597 12.205C4.99597 12.196 5.04597 12.192 5.09497 12.192C5.48697 12.192 5.83497 12.47 5.90797 12.868L6.20997 14.52C6.23997 14.684 6.36697 14.814 6.53097 14.849C7.01097 14.951 7.50297 15.002 8.00097 15.002C8.49897 15.002 8.99097 14.95 9.46997 14.849C9.63397 14.814 9.76097 14.684 9.79097 14.52L10.094 12.868C10.102 12.824 10.114 12.781 10.129 12.739C10.25 12.402 10.568 12.192 10.908 12.192C11 12.192 11.094 12.208 11.186 12.24L12.772 12.805C12.818 12.821 12.865 12.829 12.911 12.829C13.026 12.829 13.138 12.781 13.218 12.693C13.882 11.961 14.385 11.098 14.69 10.157C14.742 9.998 14.692 9.824 14.564 9.716L14.565 9.715ZM12.728 11.726L11.521 11.296C11.323 11.226 11.117 11.19 10.908 11.19C10.139 11.19 9.44697 11.676 9.18797 12.399C9.15397 12.492 9.12897 12.588 9.11097 12.686L8.88097 13.937C8.59097 13.979 8.29597 14 8.00097 14C7.70597 14 7.41097 13.979 7.11997 13.936L6.89097 12.685C6.73197 11.818 5.97697 11.189 5.09497 11.189C4.98697 11.189 4.87697 11.199 4.76597 11.219C4.66897 11.237 4.57397 11.262 4.47997 11.295L3.27297 11.725C2.90497 11.264 2.61097 10.759 2.39397 10.214L3.36797 9.391C3.74097 9.076 3.96797 8.634 4.00797 8.148C4.04797 7.662 3.89497 7.19 3.57797 6.818C3.51397 6.743 3.44297 6.672 3.36797 6.608L2.39397 5.785C2.61097 5.24 2.90497 4.734 3.27297 4.274L4.47997 4.704C4.67797 4.774 4.88397 4.81 5.09397 4.81C5.86297 4.81 6.55497 4.324 6.81397 3.601C6.84797 3.507 6.87297 3.411 6.89097 3.314L7.11997 2.063C7.41097 2.021 7.70597 1.999 8.00097 1.999C8.29597 1.999 8.59097 2.02 8.88097 2.062L9.10997 3.313C9.26897 4.18 10.024 4.809 10.906 4.809C11.014 4.809 11.124 4.799 11.234 4.779C11.331 4.761 11.427 4.736 11.521 4.703L12.728 4.273C13.096 4.733 13.39 5.239 13.607 5.784L12.634 6.607C12.261 6.922 12.033 7.364 11.994 7.85C11.954 8.336 12.107 8.809 12.424 9.18C12.489 9.256 12.559 9.326 12.635 9.39L13.609 10.213C13.392 10.758 13.098 11.264 12.73 11.724L12.728 11.726Z"/></svg></span>';
  // ==================== 全局视图选项 ====================
  var sendKeyCombo = "enter";
  var newSessionKey = "ctrl+alt+n";
  var closeSessionKey = "alt+w";
  var tabSwitchKey = "ctrl+alt+pgupdown";
  /** 文件搜索浮层（见下面「文件搜索」那一段）：不跟别的快捷键一起进设置，先写死这个。 */
  var fileSearchKey = "ctrl+shift+f";
  // 这台机器的路径分不分大小写（顶条、面板、历史列表里拿路径当键比）：
  // 后端在 viewOptions 里报（process.platform !== "win32"）。没收到之前按不分大小写算，
  // 跟以前一样；收到后就按真值。
  var caseSensitivePaths = false;
  /**
   * 地址里带了 ?session=<标识> 就切到那个会话（自己把带会话的地址存下来 / 发给别人时用）。
   * 会话壳可能还没到：先记着，等会话列表来了再切（见 sessionList 那段）。
   */
  function activateSessionFromUrl() {
    var wanted = "";
    try { wanted = new URLSearchParams(location.search).get("session") || ""; } catch (e) { wanted = ""; }
    if (!wanted) { return; }
    pendingActivateId = wanted;
    requestSwitch(wanted);
  }

  /** 两个路径字符串相比时用的写法（斜杠统一；Windows 上再转小写，见 pathRules.ts 的 pathCaseKey）。 */
  function pathCaseKey(p) {
    var s = String(p || "").replace(/\\/g, "/");
    return caseSensitivePaths ? s : s.toLowerCase();
  }
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
    if (typeof opts.closeSessionKey === "string") { closeSessionKey = opts.closeSessionKey; }
    if (typeof opts.tabSwitchKey === "string") { tabSwitchKey = opts.tabSwitchKey; }
    caseSensitivePaths = opts.caseSensitivePaths === true;
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

  // ---- 全局快捷键匹配（新建会话 / 关闭会话 / 切换会话）----
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
    // 关闭当前正在看的会话（含输入框聚焦时）：跟顶条那颗 × 同一个路数。
    // 会话正在跑：这一下只把那一格变成勾（要再点一下才真关，不然一个手滑就把跑着的一轮掐了）；
    // 已经跑完：直接关。会话文件留着，历史会话里能重新打开，关完自动切到别的会话。
    if (matchCombo(e, closeSessionKey)) {
      e.preventDefault();
      if (activeId) { askCloseSession(activeId); }
      return;
    }
    // 文件搜索（含输入框聚焦时）：在界面里弹那一块浮层；再按一次收起。
    if (matchCombo(e, fileSearchKey)) {
      e.preventDefault();
      toggleFileSearch();
      return;
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      // Alt+ 类组合在输入框里也应允许（不输入字符）
      const combos = tabSwitchCombos(tabSwitchKey);
      if (matchCombo(e, combos.prev) || matchCombo(e, combos.next)) {
        e.preventDefault();
        switchSessionByDirection(matchCombo(e, combos.next) ? "next" : "prev");
      }
      return;
    }
    // 切换会话
    const combos = tabSwitchCombos(tabSwitchKey);
    if (matchCombo(e, combos.prev)) { e.preventDefault(); switchSessionByDirection("prev"); return; }
    if (matchCombo(e, combos.next)) { e.preventDefault(); switchSessionByDirection("next"); return; }
  });

  // ==================== 会话状态 ====================
  function activeSession() { return activeId ? sessions.get(activeId) : null; }

  function createSession(id, title) {
    let st = sessions.get(id);
    if (st) { return st; }
    // 一个会话 = 一层壳（.session-view）：里面就一块消息窗格（.session-pane）。
    // 壳一直留着（切走只是盖上 .off 藏起来，见 chat.css 那段），切回去时消息、滚动位置、草稿都还在。
    const view = document.createElement("div");
    view.className = "session-view";
    view.dataset.sessionId = id;
    const pane = document.createElement("div");
    pane.className = "session-pane";
    pane.dataset.sessionId = id;
    pane.innerHTML = '<div class="empty-hint">输入消息开始对话…</div>';
    view.appendChild(pane);
    pane.addEventListener("scroll", () => {
      if (!paneShown(pane)) { return; }
      const prevTop = st.lastScrollTop;
      st.lastScrollTop = pane.scrollTop; // 滚动位置缓存：布局重建后恢复用
      // 滚得多快（见 syncViewport）：一帧里走了多少像素 / 这帧多长
      {
        const now = Date.now();
        const dt = Math.max(1, now - (st.scrollAt || now - 16));
        const dy = Math.abs(pane.scrollTop - st.scrollPrev);
        st.scrollAt = now;
        st.scrollPrev = pane.scrollTop;
        if (dy / dt > FAST_SCROLL_PX_PER_MS) { st.scrollFastUntil = now + FAST_SCROLL_GRACE_MS; }
      }
      // 整屏重画中：窗格正在被清空重建，这时的滚动动静都是重画弄的，不作数
      //（不然清空后“已经在底部”会把贴底重新打开，重放的几百条一路把人拖到底，见 finishRedraw）
      if (st.suppressScroll) { return; }
      // 滚动带着窗格动：该补的（没画的老消息）、该放的（收起来的）、该收的，下一帧统一看一眼
      if (st.older && st.older.length) { scheduleViewportCheck(st); }
      // 位置往上走了 = 人自己往回滚（程序追底只会往下写）：当场交还控制权。
      // 这是原来那套“上次程序自己设的位置 ±1 像素”记账的替代：不看是谁弄的，只看方向——
      // 也因此不怕 scroll 事件晚一帧（那套记账怕的正是这个，见 dev/followBottom.js）。
      if (pane.scrollTop < prevTop - 1) { userTookOverScroll(st); return; }
      // 反过来：本来没在跟底，人自己滚回底部了，就恢复跟随。
      // 只在“没在跟底”时才量（追底期间不量：那会让每次滚动都多逼一次排版）。
      if (!st.stickToBottom && isNearBottomPane(st)) {
        st.stickToBottom = true;
        if (st.hasNewContent) { st.hasNewContent = false; }
        syncJumpBottom(st);
        // 回到贴底：往上翻的那阵子攒着没搬的几轮，现在可以搬了（见 trimLiveTurns）
        scheduleTrimLive(st);
      }
    });
    st = {
      id,
      title: title || "新会话",
      paneEl: pane,
      viewEl: view,
      // 后端给的会话元信息（sessionList 每推一次覆盖一次）
      parentId: null,
      taba: null,
      currentAssistant: null,
      // 正在想的那一段（见 startThinking）：这一段还没想完时挂在它身上，增量往它上面加
      thinkingEntry: null,
      // 被“正文开始了”提前收起来、还没拿到全文的那一颗（见 endThinking）：个别 provider 的收尾
      // （thinking_end）比正文晚到，全文来了就补进这一条，别另开一颗。
      pendingThink: null,
      // 本段消息（上一条用户气泡之后的这一段回复）里那颗 think 标签：末尾补来的思考并到它身上，
      // 见 noteThinkingEntry / foldTailThinking。来了用户消息 / 整屏重画就归零。
      segmentThinking: null,
      // 末尾候选：本段已有 think 之后又冒出来的一颗（可能是「末尾补来的一段思考」，也可能后面
      // 还有正文 / 工具）；跑完一轮它还留在末尾就并回上面那颗，见 foldTailThinking。
      tailThinking: null,
      // 这一批（两条正文之间的那一串调用）的落脚点：那条 .tool-row，或者这一批里刚铺下的图块
      // （见 mountToolImageBlock）。来了正文 / 用户消息就归零（新的一批）。
      currentToolTail: null,
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
      // 这一轮跑完了（不管是你在看着它跑完的，还是在别处时它跑完的）：名字旁边那颗点变绿。
      // 看一眼（切到那个会话）或者又开始跑下一轮就收掉。见 markTurnDone。
      turnDone: false,
      activity: "idle",
      activityDetail: "",
      // 胶囊那颗状态动画当前挂着哪一档（等 / 写 / 想 / 工具 / 空）、什么时候换上的、
      // 以及“还没到能换的时候”那个定时器（见 syncStatus 与 ACT_MIN_MS）。
      actShown: "",
      actShownAt: 0,
      actTimer: 0,
      piReady: false,
      textDirty: false,
      rafId: 0,
      lastRenderAt: 0,
      stickToBottom: true,
      // 整屏重画（重连后补不上、页面刷新）期间：视野先冻住，画完一次放回原处。
      // redrawRestore 记着“人正看着哪几条”（null = 本来就贴底，画完跟着走到底）；
      // suppressScroll 为重画期间不吃 scrollToBottom 那一套。见 beginRedraw / finishRedraw。
      redrawRestore: null,
      suppressScroll: false,
      redrawTimer: 0,
      // 重画放回视野后还在盯着的那条消息（上面长高了就跟着补），以及这时窗格的
      // “滚动锚定”被我们临时关掉过没有。见 holdScrollOn / releaseAnchorHold。
      anchorHold: null,
      anchorOverflowDisabled: false,
      // 消息编号 → 顶层节点：重放时靠它认出“这条我已经画过”，原地留着（见 placeUnit）。
      byId: new Map(),
      // 正在“按编号对账”地重放（null = 没在重放）。见 beginReconcile / endReconcile。
      reconcile: null,
      // 从零重画时把这一串重放攒着（{ events: [] }，null = 没在攒）：见 startReplayBuf /
      // flushReplayBuf。older 是攒着但还没画的那几截（老消息，往上滑时补），
      // olderHint 是顶上那条占位（把它们的长度先顶着）。
      replayBuf: null,
      older: null,
      olderHint: null,
      olderBusy: false,
      // 攒够了就搬一轮出去（见 scheduleTrimLive）：搬的调度挂在这儿
      trimTimer: 0,
      // 补画那一套的调度：viewRaf 挂着下一帧的检查，viewTimer 挂着“停下来再看”那一下
      viewRaf: 0,
      viewTimer: 0,
      // 滚动速度的账（判断“划得快不快”，见 syncViewport）：上一次滚动事件在什么时候、
      // 那会儿滚到哪儿、以及“划得快”这个状态到什么时候为止。
      scrollAt: 0,
      scrollPrev: 0,
      scrollFastUntil: 0,
      lerpRafId: 0,
      hasNewContent: false,
      modelId: "",
      provider: "",
      thinkingLevel: "",
      // 生成速度（t/s）：后端算好了推过来（只算模型真在吐字的那段时间，见 sessionRuntime 的
      // noteGenTokens）；停了就挂着这一轮最后的数，下一轮开始清空
      tps: undefined,
      // 自动模式：auto 是这个会话的开关状态（后端推来，见 case "auto"），
      // autoTitle 是那颗按钮指上去说什么（后端拼好，见 auto.ts 的 autoIndicatorTitle）。
      auto: null,
      autoTitle: null,
      // 工具调用耗时（见 noteToolDuration / renderToolStats）：只算这次打开页面之后跑过的调用。
      // byTool：工具名 → { count, totalMs, maxMs }；slowest：跑得最久的那几次（最多 TOOL_STATS_SLOWEST 条）。
      toolStats: { calls: 0, totalMs: 0, byTool: new Map(), slowest: [] },
      queuedSteering: [],
      pendingSteerRestore: null,
      autoLoadHinted: false,
    };
    sessions.set(id, st);
    return st;
  }

  /**
   * 把一个会话的壳摆到前台，其余会话的壳盖上“藏起来”（.off，见 chat.css 那段注释）。
   * 壳一直留在 #messages 里：藏起来的东西不排版，但排版结果浏览器留着，切回去不用重排。
   */
  function mountActiveSession() {
    const target = activeId ? sessions.get(activeId) : null;
    // 手机上左右划切会话的收尾：松手时已经跟后端要了这个会话，它回话（切到了）就到这儿来。
    // 要从手指离开的那个位置接着滑，别一下跳过去——所以这一段排在下面“摆前台 / 盖起来”前面。
    if (pendingSlide) {
      const slide = pendingSlide;
      if (target && target.id === slide.toId) {
        pendingSlide = null;
        clearTimeout(slide.timer);
        finishSlideMount(slide, target);
        return;
      }
      // 还没轮到它（后端先推了会话列表，“切到哪个”还在路上）：这一趟先摆着，
      // 下面照常办，但那个已经摆出来的壳别盖回去（见 held）
    }
    if (target) { unkeep(target); }
    if (target && target.viewEl.parentElement === messagesEl && !target.viewEl.classList.contains("off")) { return; }
    // 左右划摆出来的那个还没轮到：它这会儿是露着的，别当成“不在看的”盖回去
    const held = pendingSlide ? pendingSlide.toView : (swipe ? swipe.toView : null);
    sessions.forEach((st) => {
      if (st.viewEl === held) { return; }
      st.viewEl.classList.toggle("off", st !== target);
    });
    const st = target;
    if (!st) { return; }
    // 只在没挂过的时候真挂一次：已经挂着的再 appendChild 等于挪一下，浏览器会把里头的排版丢掉重排
    if (st.viewEl.parentElement !== messagesEl) { messagesEl.appendChild(st.viewEl); }
    // 重挂载后把滚动位置恢复回去（贴底的直接贴底）
    const p = st.paneEl;
    if (st.stickToBottom) {
      p.scrollTop = p.scrollHeight;
      st.lastScrollTop = p.scrollTop;
    } else if (typeof st.lastScrollTop === "number") {
      p.scrollTop = st.lastScrollTop;
    }
    // 重挂载会让 CSS 动画重播：剥掉历史气泡的入场动画，避免整窗“抖一下”
    st.viewEl.querySelectorAll(".msg-enter").forEach((el) => { el.classList.remove("msg-enter"); });
  }

  /**
   * 松手那一刻就把两个壳摆到位：进来的那个滑到正中，原来那个滑出屏外。
   * 不等后端回话（它的回话只决定“这次算不算切过去”；等人的话，快划时松手后就会冻住一瞬）。
   * 滚动位置也在这里恢复：进来那一屏得先摆好在它该在的地方、好让人看到它滑进来。
   */
  function slideToPlace(slide, target) {
    const to = target.viewEl;
    unkeep(target);
    to.classList.remove("off");
    if (to.parentElement !== messagesEl) { messagesEl.appendChild(to); }
    const p = target.paneEl;
    if (target.stickToBottom) {
      p.scrollTop = p.scrollHeight;
      target.lastScrollTop = p.scrollTop;
    } else if (typeof target.lastScrollTop === "number") {
      p.scrollTop = target.lastScrollTop;
    }
    // 重挂载会让 CSS 动画重播：剥掉历史气泡的入场动画，避免整窗“抖一下”
    to.querySelectorAll(".msg-enter").forEach((el) => { el.classList.remove("msg-enter"); });
    slideTo(to, 0, SWIPE_FINISH_MS);
    slideTo(slide.fromView, slide.endX, SWIPE_FINISH_MS);
    afterSlide(to, () => { slide.landed = true; });
  }

  /**
   * 后端回话说“切到这个了”（可能是滑到位之后才到，也可能还没到）：
   * 已经摆好了就只收尾，没摆完就接着把它滑完。
   * 其余收尾跟普通切换一样（滚动位置恢复、切成“在看的那个”）。
   */
  function finishSlideMount(slide, target) {
    const from = slide.fromView;
    const to = target.viewEl;
    const cleanup = () => {
      sessions.forEach((st) => { st.viewEl.classList.toggle("off", st !== target); });
      clearSlideStyles(from);
      clearSlideStyles(to);
      messagesEl.classList.remove("swiping");
    };
    if (slide.landed) { cleanup(); return; }
    slideToPlace(slide, target);
    afterSlide(to, cleanup);
  }

  /**
   * 这个窗格这会儿真在屏幕上吗（不是在看的那个会话 / 加载更早那批消息的暂存区）。
   * 以前这里只看 isConnected：壳切成“留在页面里、盖上 .off”之后，藏着的那些也算连着，
   * 得把 .off 一并算进来，不然藏着的会话里的滚动、追底会跟着动。
   */
  function paneShown(pane) {
    if (!pane || !pane.isConnected) { return false; }
    return !(pane.closest && pane.closest(".session-view.off"));
  }

  // ==================== 闲下来的时候把别的会话先排好版（“停着”）====================
  //
  // 藏起来的壳（.off）浏览器不排版，这个页面第一次切过去得现排一遍（1000 轮对话量过
  // 100—160 毫秒，见 dev/switchPerf.js）；停着的那种把版排好了留着（.off.kept），
  // 切过去只把它画出来（同一份内容 12—20 毫秒）。
  //
  // 只停“这会儿没事”的会话：它一来消息就立刻收回去（.kept 摘掉，回到不排版的 .off），
  // 免得流式输出每长一段都排一次版。同时停着的也就 KEPT_MAX 个，多出来的先放掉最旧的
  // （排好版的那些占着内存）。窗口一变宽窄它们全要重排：先全放掉，闲下来再停一遍。
  const KEPT_MAX = 3;
  const KEEP_DELAY_MS = 1500;
  const keptIds = [];   // 停着的那些，按停下来的先后排（超过上限先放掉最前面的）
  let keepTimer = 0;

  function scheduleKeep() {
    if (keepTimer) { return; }
    keepTimer = setTimeout(() => { keepTimer = 0; keepStep(); }, KEEP_DELAY_MS);
  }

  /** 收回去：不再留着它排好的版。 */
  function unkeep(st) {
    const at = keptIds.indexOf(st.id);
    if (at >= 0) { keptIds.splice(at, 1); }
    if (st.viewEl.classList.contains("kept")) { st.viewEl.classList.remove("kept"); }
  }

  /** 放掉所有停着的（窗口一变宽窄，它们的版全要重排：不如先放掉，等闲下来再停一遍）。 */
  function unkeepAll() {
    for (const id of keptIds.slice()) {
      const st = sessions.get(id);
      if (st) { unkeep(st); } else { keptIds.shift(); }
    }
  }

  /** 闲下来了：挑一个该停的会话停一下；还有下一个就接着停。 */
  function keepStep() {
    const st = nextKeepTarget();
    if (!st) { return; }
    const view = st.viewEl;
    // 入场动画那些类先摘了再排：不然停着时排好的版一露出来就要给几百条消息重算样式
    //（这活儿放闲着的时候做，也正是这儿的意义）。
    view.querySelectorAll(".msg-enter").forEach((el) => { el.classList.remove("msg-enter"); });
    // 先盖上“不在看”（不然挂进 #messages 的那一下会当成正在看的那个摆出来）
    view.classList.add("off");
    if (view.parentElement !== messagesEl) { messagesEl.appendChild(view); }
    view.classList.add("kept");
    keptIds.push(st.id);
    while (keptIds.length > KEPT_MAX) {
      const oldest = sessions.get(keptIds[0]);
      if (oldest) { unkeep(oldest); } else { keptIds.shift(); }
    }
    scheduleKeep();
  }

  /** 下一个该停的会话：藏着、没事、有内容。（停着的那个已经有版了，不用再停；
   *  它一来消息就会被 unkeep 收回，过一会儿再停一遍。）
   *  露在外面的（虽然不是在看的那个）也不停：那就是左右划到一半、被手指拉进来的那个壳。 */
  function nextKeepTarget() {
    for (const id of sessionOrder) {
      if (id === activeId) { continue; }
      const st = sessions.get(id);
      if (!st || st.streaming || st.loading || st.reconcile) { continue; }
      if (!st.viewEl.classList.contains("off")) { continue; }
      if (st.viewEl.classList.contains("kept")) { continue; }
      if (!st.paneEl.childElementCount) { continue; }
      return st;
    }
    return null;
  }

  /**
   * 会话在界面上显示的名字：优先用 pi 起的标题（自动命名扩展 / /name 写的，如“上传插件到 GitHub”），
   * 它还没出来时用我们自己的随机名（“沉静的雪豹”）。
   */
  function sessionLabel(st) {
    if (!st) { return "还没有会话"; }
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

  /**
   * 这个会话派出去的子会话里，有几个已经跑完了（第一轮结束、结果交回去了，会话还留着）。
   * 顶条那颗小点用它：没有子会话在跑的时候点亮一颗绿点（不闪），一眼知道活干完了。
   */
  function doneChildCount(id) {
    let n = 0;
    for (const s of sessions.values()) {
      if (s.parentId !== id) { continue; }
      if (s.streaming || s.loading) { continue; }
      if (s.taba && s.taba.state === "waiting") { n++; }
    }
    return n;
  }

  // ==================== 顶条那一排会话格 ====================
  // 一格一个主会话（跟 ▾ 那张清单同一份行：主会话，加上本屏正在看的那个子会话）。
  // 点别的格直接切过去；点当前这一格什么也不做（关会话点每格自己那颗 ×）。
  // 骨架里那一格（#sessionName）头一回要画时拿去做某一格。
  let spareTabEl = sessionNameBtn;
  const sessionTabEls = new Map();     // sessionId -> 它那一格的元素

  /** 取某一格（没有就造一个）：一格 = 小点（底下挂子会话个数）+ 名字 + 一颗 ×。 */
  function sessionTabEl(sessionId) {
    let el = sessionTabEls.get(sessionId);
    if (el) { return el; }
    if (spareTabEl) { el = spareTabEl; spareTabEl = null; }
    else {
      el = document.createElement("button");
      el.type = "button";
      el.innerHTML = '<span class="sn-mark"><span class="sn-dot"></span><span class="sn-count"></span></span>'
        + '<span class="sn-text"></span>';
    }
    el.classList.add("sn-tab");
    // 骨架里那一格一开始是藏着的（没会话时不许孤零零挂在顶条中间，见 renderHtml）：
    // 这会儿真拿它当一格用了，露出来
    el.classList.remove("hidden");
    // 名字后面那颗 ×（每格都露着）：点它关的就是这一格，点名字身上还是切过去。
    // 会话正在跑时这一下只把它变成勾（要再点一下才真关，见 askCloseSession）。
    if (!el.querySelector(".sn-close")) {
      const close = document.createElement("span");
      close.className = "sn-close";
      close.title = "关闭这个会话";
      close.setAttribute("aria-label", "关闭这个会话");
      close.innerHTML = ICONS["close-bold"];
      close.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(sessionId); });
      el.appendChild(close);
    }
    // 点这一格：不是当前这个就切过去（一下就换了）；就是当前这个什么也不做
    // （以前点它会掉出清单，现在清单只列摆不下、被藏起来的那几格，摆得下的用不着从里头挑）
    el.addEventListener("click", () => {
      if (activeId === sessionId) { return; }
      closeSessionMenu();
      requestSwitch(sessionId);
    });
    sessionTabEls.set(sessionId, el);
    return el;
  }

  /** 画一遍这一排格（顺序就是清单的顺序）。 */
  function renderSessionTabs(items) {
    // 关掉的会话：它那一格从 DOM 里摘掉
    for (const [id, el] of sessionTabEls) {
      if (items.some((item) => item.sessionId === id)) { continue; }
      if (el.parentElement) { el.parentElement.removeChild(el); }
      sessionTabEls.delete(id);
    }
    items.forEach((item) => {
      const el = sessionTabEl(item.sessionId);
      const st = sessions.get(item.sessionId);
      // 派出去的子会话还有几个在跑 / 几个跑完了：小点底下那个数、那颗绿点用它
      const kids = st ? runningChildCount(st.id) : 0;
      const doneKids = st ? doneChildCount(st.id) : 0;
      const nameEl = el.querySelector(".sn-text");
      if (nameEl) { nameEl.textContent = item.label || ""; }
      const countEl = el.querySelector(".sn-count");
      if (countEl) { countEl.textContent = kids > 0 ? String(kids) : ""; }
      el.classList.toggle("current", !!item.current);
      el.classList.toggle("streaming", !!(item.streaming || item.loading));
      // 派出去的子会话还在跑：本会话自己闲着也把那颗点亮出来（一样呼吸），
      // 一眼看得出这一家子还在干活（等的是子会话，不是本会话在答）。
      el.classList.toggle("child-running", kids > 0);
      // 绿点：这一轮跑完了（不管当时有没有看着它），或者派出去的子会话跑完了、又没有谁在跑
      el.classList.toggle("done", !!item.turnDone || (doneKids > 0 && kids === 0));
      // 目录放在这一格身上（顶条上不写目录了；调试脚本要知道“当前会话跑在哪儿”就取这个）
      el.dataset.cwd = item.cwd || "";
      el.title = (item.label || "")
        + (kids > 0 ? "，" + kids + " 个子会话在跑" : "")
        + (doneKids > 0 && kids === 0 ? "，" + doneKids + " 个子会话跑完了" : "")
        + (item.cwd ? "\n" + item.cwd : "")
        + "\n" + (item.current ? "当前会话" : "点这里切过去");
      // 当前这一格就叫 #sessionName（“当前会话叫什么”照旧拿这个名字找）
      if (item.current) { el.id = "sessionName"; }
      else if (el.id) { el.removeAttribute("id"); }
      // 按清单顺序摆，▾ 永远在最后
      sessionTabRow.insertBefore(el, sessionCaret);
    });
    // 上面那一趟会把每一格重写一遍（名字、小点）：哪一格在等第二下确认跟一遍
    refreshSessionTabClose();
  }

  /**
   * 那一格上的 × 换成勾没有：正在等第二下确认的那一格（会话在跑，见 askCloseSession）变红、
   * 那颗叉换成勾。没变就不动它（重画一次等于把 svg 换掉，会闪）。
   */
  function refreshSessionTabClose() {
    for (const [id, el] of sessionTabEls) {
      const close = el.querySelector(".sn-close");
      if (!close) { continue; }
      const waiting = pendingCloseId === id;
      if (el.classList.contains("closing") === waiting) { continue; }
      el.classList.toggle("closing", waiting);
      close.innerHTML = waiting ? ICONS["check-bold"] : ICONS["close-bold"];
      close.title = waiting ? "再点一下就关掉（这个会话正在跑）" : "关闭这个会话";
      close.setAttribute("aria-label", waiting ? "再点一下就关掉" : "关闭这个会话");
    }
  }

  /**
   * 摆得下几格：先按原样量一遍，放不下就只留摆得下的（从当前这一格起往后塞、再往前补），
   * 其余的藏起来 —— 藏起来的都在 ▾ 那张完整清单里。
   * 顶条一变宽窄（窗口、左边文件侧边栏、右边那一列）就重新摆一次。
   * 排尾那颗 ▾ 只在真有格子被藏起来时才露面（全放得下时点开也没别的可挑）：
   * 它自己也占一块地方，露不露面会改这一排能用的宽度，所以两头对上为止（两趟就稳）。
   */
  function layoutSessionTabs() {
    // 藏着的（骨架里那一格没被用上时，见 renderHtml）不算这一排的东西：量到 0 宽也会占一格的位置
    const tabs = Array.prototype.filter.call(sessionTabRow.children, (el) => el.classList.contains("sn-tab") && !el.classList.contains("hidden"));
    if (!tabs.length) { sessionCaret.classList.add("hidden"); return; }
    for (let pass = 0; pass < 3; pass++) {
      const hidden = layoutTabsOnce(tabs);
      if ((hidden > 0) === !sessionCaret.classList.contains("hidden")) { return; }
      sessionCaret.classList.toggle("hidden", hidden === 0);
    }
  }

  /** 量一遍、把放不下的那几格藏起来；返回一共藏起来几格（▾ 露不露面看它，见 layoutSessionTabs）。 */
  function layoutTabsOnce(tabs) {
    // 量之前先把上一回藏起来的放出来：藏着的量不到宽（量到的会是 0）
    tabs.forEach((el) => { el.classList.remove("tab-hidden"); });
    const widths = tabs.map((el) => el.offsetWidth);
    // ▾ 收起来时它量到 0（display: none）：那一块地方就还给这排格了
    const caretW = sessionCaret.offsetWidth ? sessionCaret.offsetWidth + TAB_GAP : 0;
    const room = Math.max(0, sessionTabRow.clientWidth - caretW);
    const need = (from, to) => {
      let w = 0;
      for (let i = from; i < to; i++) { w += widths[i] + (i > from ? TAB_GAP : 0); }
      return w;
    };
    let start = 0;
    let end = tabs.length;
    if (need(0, tabs.length) > room) {
      // 当前这一格一定留着（就算它自己都放不下也留着：名字自己省略）
      const curIdx = tabs.findIndex((el) => el.classList.contains("current"));
      start = curIdx < 0 ? 0 : curIdx;
      end = start + 1;
      while (end < tabs.length && need(start, end + 1) <= room) { end++; }
      while (start > 0 && need(start - 1, end) <= room) { start--; }
    }
    for (let i = 0; i < tabs.length; i++) {
      if (i < start || i >= end) { tabs[i].classList.add("tab-hidden"); }
    }
    return start + (tabs.length - end);
  }

  /**
   * 那一排格列哪些会话：主会话，加上本屏正在看的那个（子会话平时不占格）。
   * 正在看的那个得列：它一定摆得出来（见 layoutSessionTabs），会话在跑时按 Ctrl+Alt+W
   * 那一下变成的勾就落在它身上；要是它正好是个子会话、这里却没有它，那一下就没处落。
   * 父会话已经关掉的子会话会以主会话的身份出现在 openSessionItems() 里（depth 为 0），
   * 那种照列——它已经是一个独立会话了。
   */
  function sessionTabItems() {
    return openSessionItems().filter((item) => !item.depth || item.current);
  }

  /** 顶条那一排格：一格一个主会话（带在跑的小点、派出去的子会话个数、关它的那颗 ×）。 */
  function renderSessionBar() {
    const items = sessionTabItems();
    renderSessionTabs(items);
    // ▾ 露不露面在这一步里定（有格子被藏起来才露）
    layoutSessionTabs();
    // 清单开着的时候它会跟着变（换会话、改标题、某个会话跑完了）：重画完还要重新摆——
    // 内容变宽变窄了，贴着屏幕边的位置就不对了。
    refreshSessionMenu();
    // 顶条自己也会长高变矮（目录那行有 / 没有）：两边常驻那一列的面板头跟着它齐（见 syncDockHeaderHeight）
    syncDockHeaderHeight();
  }

  // ==================== 顶条排尾那颗 ▾ 的下拉框 ====================
  // 点排尾那颗 ▾ → 从它下面掉出一张清单，列的只是「顶条上摆不下、被藏起来的那几格」
  // （摆得下的直接点格子就行）：点一行就切过去。
  // 这一格永远摆得出来（见 layoutSessionTabs），所以清单里不会有当前这个。
  // 看历史 / 换工作区 / 在别的目录里开会话也走「项目与会话」面板。
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
    // 贴在当前那一格底下（点 ▾ 掉出来的也一样：那一格就在 ▾ 边上，不会跑太远）
    const cur = activeId ? sessionTabEls.get(activeId) : null;
    const anchor = (cur || sessionCenterEl || sessionNameBtn).getBoundingClientRect();
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
   * 那张清单要列的行：顶条上被藏起来的那几格（摆得下的直接点格子，不靠这张清单）。
   * 一格被藏没藏，看它身上那个类（layoutSessionTabs 摆出来的）。
   */
  function overflowSessionItems() {
    return sessionTabItems().filter((item) => {
      const el = sessionTabEls.get(item.sessionId);
      return !!el && el.classList.contains("tab-hidden");
    });
  }

  /** 画一遍清单内容：一行一个（行尾一颗关闭叉；会话正在跑时点了先变确认条，再点勾才真关）。 */
  function renderSessionMenu() {
    sessionMenuEl.innerHTML = "";
    overflowSessionItems().forEach((item) => {
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
        // 点过行尾那颗叉（这个会话正在跑，还得再点一下）：整行底色变红，行尾多一颗勾——点勾才真关，点叉撤销。
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
        // 行尾不再挂「当前」/「在跑」：当前那条整行有底色，在跑 / 跑完了看名字前头那颗小点。
        // 行尾这颗叉：点行是切过去（大目标），点叉才关（会话正在跑时要再点一下勾）。
        const close = document.createElement("span");
        close.className = "sm-close";
        close.title = "关闭这个会话";
        close.setAttribute("aria-label", "关闭这个会话");
        close.innerHTML = ICONS["close-bold"];
        close.addEventListener("click", (e) => { e.stopPropagation(); askCloseSession(item.sessionId); });
        el.appendChild(close);
        el.addEventListener("click", () => {
          closeSessionMenu();
          if (!item.current) { requestSwitch(item.sessionId); }
        });
      }
      sessionMenuEl.appendChild(el);
    });
  }

  /** 清单开着就重画一遍（关会话的确认条变来变去）；重画完还得重新摆位（宽窄变了：确认条那阵宽度是钉住的）。 */
  function refreshSessionMenu() {
    if (!sessionMenuOpen) { return; }
    // 行都关没了就先收起这张空壳（全摆得下了、或者被藏起来的都关掉了）
    if (!overflowSessionItems().length) { closeSessionMenu(); return; }
    renderSessionMenu();
    placeSessionMenu();
  }

  function openSessionMenu() {
    // 顶条全摆得下（没有格子被藏起来）：没东西可翻，不开这张空壳
    if (!overflowSessionItems().length) { return; }
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
  // 宽窄一变，“停着”的那些会话的版全要重排：先全放掉，闲下来会自动再停一遍（见 unkeep）
  window.addEventListener("resize", unkeepAll);

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
  /**
   * 离底部这么近就直接过去，不再一帧一帧地缓（见 lerpScrollStep）。
   *
   * 流式输出时内容每来一小段就把底部往下推十几像素。原来的尺子是“差 1 像素以内算到底”，
   * 那点距离永远达不到：每来一小段就要连排两三帧、连写两三次 scrollTop 才收尾。
   * 实测（贴底流式 6 秒、240 批内容）：写入从 316 次降到 241 次、排帧从 556 降到 481。
   * 排版次数不变（264 → 263）：那是“量一次底部有多远”的固有开销，这个阀值动不了它。
   */
  const STICK_JUMP_PX = 120;
  function isNearBottomPane(st) {
    return st.paneEl.scrollHeight - st.paneEl.scrollTop - st.paneEl.clientHeight <= BOTTOM_THRESHOLD;
  }
  function lerpScrollStep(st) {
    if (!st.stickToBottom) { st.lerpRafId = 0; return; }
    const target = st.paneEl.scrollHeight - st.paneEl.clientHeight;
    const cur = st.paneEl.scrollTop;
    const diff = target - cur;
    if (Math.abs(diff) <= STICK_JUMP_PX) { st.paneEl.scrollTop = target; st.lastScrollTop = target; st.lerpRafId = 0; return; }
    const next = cur + diff * 0.3;
    st.paneEl.scrollTop = next;
    st.lastScrollTop = next;
    st.lerpRafId = requestAnimationFrame(() => lerpScrollStep(st));
  }
  function smoothScrollToBottom(st) {
    // 只对挂在页面上的窗格（当前会话那个）追底
    if (!paneShown(st.paneEl)) { return; }
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
    // 整屏重画中：重放出来的几百条老消息不该一条一条把人拽到底，等画完一次放好（见 finishRedraw）
    if (st.suppressScroll) { return; }
    if (!force && !st.stickToBottom) { return; }
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); st.lerpRafId = 0; }
    st.stickToBottom = true;
    st.hasNewContent = false;
    syncJumpBottom(st);
    // 窗格没挂在页面上（「加载更早」那批消息的暂存区、后台会话）时只记状态，不排追底那一帧。
    // 排了的话，等这一帧真跑起来时 paneEl 可能已经换人（暂存区用完就还回真窗格了），
    // 结果滚的是真窗格——点「加载更早」视野就无缘无故甩到底部。
    const pane = st.paneEl;
    if (!paneShown(pane)) { return; }
    if (st.scrollRafId) { return; }
    st.scrollRafId = requestAnimationFrame(() => {
      st.scrollRafId = 0;
      if (st.paneEl !== pane || !paneShown(pane)) { return; }
      // 这一帧排上之后人自己往回滚了、或者正好开始整屏重画：这一下不许落下去
      if (st.suppressScroll || !st.stickToBottom) { return; }
      pane.scrollTop = 1e9;   // 夹到最大：没有读 scrollHeight，就不会逼出一次同步重排
      // 读回来记一份（赋值时已经排过版，不额外加开销）：“重挂会话时按这个恢复”。
      // 以前这里还要记“这次是自己滚的”（给 scroll 监听认人用）；现在认人靠方向（见上面那个监听）。
      st.lastScrollTop = pane.scrollTop;
    });
  }
  // ==================== 整屏重画时的视野（重连后补不上、页面刷新） ====================
  //
  // 重画是“clear 清空窗格 + 从会话历史一条条重放”。对贴底的人来说没什么（照样跟着到底），
  // 但人要是正在往上翻旧内容，重放会把视野冲到底部，画完也回不到原处。所以：
  //   1. clear 之前先记下“视野最上面那几条消息是谁、偏了多少”；
  //   2. 重画期间不吃 scrollToBottom（重放的那几百条可能一条一条往下拽）；
  //   3. 插件说完 syncPoint（这一屏重画完了）再把人放回那条消息上，随后再盯一小会儿
  //      （图解码、代码高亮会把上面的高度慢慢撑起来）。
  // 消息在界面上没有编号，所以按“类型 + 开头一段文字 + 这段文字是第几次出现”认：
  // 重画是从会话历史重新画的，同一条消息画出来的开头几个字不变，重复的句子靠“第几次”分开。

  /** 一条消息的“身份”（内容）：类型 + 开头一段文字，不看编号。 */
  function messageSignature(el) {
    const raw = el.dataset && typeof el.dataset.raw === "string" ? el.dataset.raw : (el.textContent || "");
    return el.className + "\u0000" + raw.slice(0, 120);
  }

  /**
   * 这条能不能当“视野的记号”。
   * 工具行、正在跑的那一条不算：它们重画后变样（跑着的标签变成结果、几颗小标签并成一行、
   * read 读来的图换成一块图），拿它们对不上。只在真的只剩它们时拿它们兜底。
   */
  function isSteadyMessage(el) {
    if (!el.classList || !el.classList.contains("msg")) { return false; }
    return !el.classList.contains("tool-row") && !el.classList.contains("tool-running");
  }

  /** 每个元素“同一条文字在窗格里是第几次出现”（1 起）；一样的文字才用得着这个数。 */
  function messageOrdinals(kids) {
    const counts = new Map();
    const order = new Map();
    for (const el of kids) {
      const sig = messageSignature(el);
      const n = (counts.get(sig) || 0) + 1;
      counts.set(sig, n);
      order.set(el, n);
    }
    return order;
  }

  /**
   * 记下视野里最上面那几条消息（贴底的人不用记：画完照旧到底）。
   * 记一串而不是一条：最上面那条可能正好是重画后会变样的东西，往下退着找对得上的。
   * @returns null 表示贴底，或窗格没挂在页面上（那个会话这会儿没人看）。
   */
  function takeScrollAnchor(st) {
    const pane = st.paneEl;
    if (st.stickToBottom || !paneShown(pane)) { return null; }
    const top = pane.scrollTop;
    const kids = Array.from(pane.children);
    const order = messageOrdinals(kids);
    const seen = kids.filter((el) => el.offsetTop + el.offsetHeight > top + 1);
    const steady = seen.filter(isSteadyMessage);
    const list = steady.length > 0 ? steady : seen;
    const candidates = [];
    for (const el of list.slice(0, 6)) {
      candidates.push({
        sig: messageSignature(el),
        ordinal: order.get(el) || 0,
        mid: (el.dataset && el.dataset.mid) || "",
        offset: top - el.offsetTop,
      });
    }
    return candidates.length > 0 ? { candidates } : null;
  }

  /**
   * 在重画后的窗格里找当初那几条里的哪一条还在（从最上面那条往下找）。
   * 先按“内容 + 第几次出现”认（实时画的和重放画的都对得上）；认不出再拿编号认。
   */
  function findScrollAnchor(pane, candidates) {
    const kids = Array.from(pane.children);
    const order = messageOrdinals(kids);
    for (const c of candidates) {
      const el = kids.find((k) => messageSignature(k) === c.sig && order.get(k) === c.ordinal)
        || (c.mid ? kids.find((k) => (k.dataset && k.dataset.mid) === c.mid) : undefined);
      if (el) { return { el, offset: c.offset }; }
    }
    return null;
  }

  /** 重画开始：记下视野，并且这批重放先别跟着往下滚。 */
  function beginRedraw(st) {
    if (st.redrawTimer) { clearTimeout(st.redrawTimer); }
    releaseAnchorHold(st);
    st.redrawRestore = takeScrollAnchor(st);
    st.suppressScroll = true;
    // 重画期间位置由我们自己放（finishRedraw）：先关掉浏览器那套滚动锚定，免得两边都补
    st.paneEl.style.overflowAnchor = "none";
    st.anchorOverflowDisabled = true;
    // 重画之前排着的“追底”那一帧（上一刻还在流式输出就会有一条）作废：
    // 它落下去的时候窗格已经被清空重建了，一落就是砸到半截内容的底部
    if (st.scrollRafId) { cancelAnimationFrame(st.scrollRafId); st.scrollRafId = 0; }
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); st.lerpRafId = 0; }
    // 兜底：syncPoint 没等到（旧版后端、或者那一条半路丢了）也别一直不跟着走
    st.redrawTimer = setTimeout(() => { if (st.suppressScroll) { finishRedraw(st); } }, 8000);
  }

  /**
   * 重画完了：把视野放回原处。
   * 人本来就贴底、或者当初看着的那条这次没画出来（只补了最近一段）就回到最新——
   * 反正原来那些内容这次已经不存在了，留在原地只会停在半空。
   */
  function finishRedraw(st) {
    if (st.redrawTimer) { clearTimeout(st.redrawTimer); st.redrawTimer = null; }
    // 攒着的重放还没画（syncPoint 没到、定时器兜底到这儿）：先画出来再放视野
    flushReplayBuf(st);
    const anchor = st.redrawRestore;
    st.redrawRestore = null;
    if (!st.suppressScroll) { return; }
    st.suppressScroll = false;
    const pane = st.paneEl;
    if (!paneShown(pane)) { releaseAnchorHold(st); return; }
    const found = anchor ? findScrollAnchor(pane, anchor.candidates) : null;
    if (!found) { releaseAnchorHold(st); scrollToBottom(st, true); return; }
    const el = found.el;
    // 人本来就停在老地方：别跟着往下追；底下确实又长了一截，「跳到最新」亮着
    st.stickToBottom = false;
    st.hasNewContent = true;
    pane.scrollTop = Math.max(0, el.offsetTop - found.offset);
    st.lastScrollTop = pane.scrollTop;   // 记上：后面重挂会话时会按这个恢复
    syncJumpBottom(st);
    // 后到的高度（图解码、代码高亮重排）会把视野挤走：盯一小会儿，它挪多少补多少
    holdScrollOn(st, el);
  }

  /** 放手之前最多盯多久（从画完算）。 */
  var ANCHOR_HOLD_MS = 3000;

  /**
   * 把视野钉在某一条消息上，盯一小会儿。
   * 为什么不能只对两帧：重画是把整段历史又画一遍，图片要解码、代码要重新高亮，
   * 这些东西的高度是随后几百毫秒里一点点长出来的；视野上面长多少，下面的人就被挤走多少。
   * 只在“那条消息自己的位置变了”时才补：人滚窗格不会让它变，所以不会跟人抢；
   * 人真的一碰（滚轮 / 触屏），立刻停手。
   */
  function holdScrollOn(st, el) {
    const pane = st.paneEl;
    // 盯的是“它这会儿在视野里的位置”，不是它自己的 offsetTop：上面长高会把它挤下去，
    // 别的东西（晚到的排版、另一次放位置）也可能把 scrollTop 挪走——两种都算“视野跑了”，
    // 一并对回来才稳
    const view = el.offsetTop - pane.scrollTop;
    const hold = { el: el, view: view, until: Date.now() + ANCHOR_HOLD_MS };
    st.anchorHold = hold;
    const stop = () => { if (st.anchorHold === hold) { releaseAnchorHold(st); } };
    pane.addEventListener("wheel", stop, { passive: true, once: true });
    pane.addEventListener("touchstart", stop, { passive: true, once: true });
    const step = () => {
      if (st.anchorHold !== hold) { return; }        // 人接手了 / 又开了一次重画
      if (st.paneEl !== pane || !paneShown(pane) || el.parentNode !== pane) { releaseAnchorHold(st); return; }
      const now = el.offsetTop - pane.scrollTop;
      if (Math.abs(now - hold.view) > 1) {
        pane.scrollTop = Math.max(0, el.offsetTop - hold.view);
        st.lastScrollTop = pane.scrollTop;
      }
      if (Date.now() < hold.until) { setTimeout(step, 100); } else { releaseAnchorHold(st); }
    };
    setTimeout(step, 100);
  }

  // ==================== 整屏重画：按编号对账（原地留着、只补缺的） ====================
  //
  // 后端重放历史时，每条消息都带一个稳定的编号（id：h12、h12:b0 这样，见
  // src/sessionRuntime.ts 的 renderMessages）。重放前先发一条 clear（带 reconcile 标记），
  // 界面**不清空窗格**，而是按编号对账：
  //   · 这个编号的节点已经在页面上 → 挪到该在的位置、原样留着（内容变了才重画）；
  //   · 没有 → 建一个，插在“上一个重放出来的节点”后面；
  //   · 重放从头到尾没提到、也没被认领的旧节点 → 收掉（历史里已经没有它们了）。
  //
  // 这么一来，断线期间漏掉的那几条会被补进它们该在的位置，而人正看着的那一段
  // 始终是同一个节点：滚动位置、图片、折叠起来的正文、卡片里打了一半的字都还在。
  // 认不出编号的东西（工具行、think、正在跑的那一条、末尾胶囊）照旧重建——它们没有
  // 用户输入、也不含图片，重建一下看不出来。

  /** 把一个顶层节点放到“重放游标”那儿（不在重放时就是追加到末尾）。 */
  /**
   * 把一个顶层节点放到“重放游标”那儿。
   * @param force 实时的消息默认一律接到末尾（它们不是历史的一部分：断线中间还在长的正文、
   *              刚发出去的消息，插到游标处会在历史中间多出一截）；卡片这种“重发一遍、
   *              本来就该在流程里”的例外传 true，也走游标。
   */
  function placeUnit(st, el, force) {
    const pane = st.paneEl;
    const rec = st.reconcile;
    // 不在对账中，或者正在往「加载更早」的暂存区（paneEl 被临时换成 _stage）里画：
    // 都只是追加，别去动对账那只游标（它属真正的那块窗格）
    if (!rec || rec.pane !== pane) { pane.appendChild(el); return el; }
    if (!force && !st.replayNow) { rec.touched.add(el); pane.appendChild(el); return el; }
    rec.touched.add(el);
    if (rec.alignNext) {
      // 这一遍的第一条决定游标从哪儿起。
      //   · 它本来就在窗格里（编号认得出来）：就从它这儿起；
      //   · 认不出编号（实时画出来的节点没有编号，而窗口模式重放的正好是这一段）：
      //     找一条“看起来一样”的旧节点，从它这儿起——重放的这批是接在它后面的，
      //     上面那些更早的消息（窗口外面、用户自己翻出来的）得留着。
      rec.alignNext = false;
      if (el.parentNode === pane) {
        rec.cursor = el;
      } else {
        const twin = Array.from(pane.children).find((k) => sameContent(k, el));
        if (twin) { rec.cursor = twin; }
      }
    }
    const cur = rec.cursor;
    if (cur === el) {
      // 正好就是下一个该处理的旧节点：原地不动
    } else if (cur && cur.parentNode === pane) {
      if (cur.previousSibling !== el) { pane.insertBefore(el, cur); }
    } else if (el.parentNode !== pane || pane.lastChild !== el) {
      pane.appendChild(el);
    }
    rec.cursor = el.nextSibling;
    rec.last = el;
    return el;
  }

  /**
   * 这会儿是不是在往「加载更早」的暂存区里画（`historyBatchEvent` 会把 `paneEl` 临时换成
   * 那块 detached 的 `_stage`）。暂存区是另一份渲染，不许去认领真窗格里的节点、也不许改编号表：
   * 认领会把真窗格里的节点（比如 read 的图块）搬进暂存区，插回来的时候就跑到顶上去了。
   */
  function isStageRender(st) {
    return !!st._stage && st.paneEl === st._stage;
  }

  /** 收掉一个顶层节点，顺手把编号表里那笔也删了（不然悬空引用越攒越多、下标复用还会“复活”死节点）。 */
  function forgetUnit(st, el) {
    const mid = el.dataset ? el.dataset.mid : "";
    if (mid) { st.byId.delete(mid); }
    el.remove();
  }

  /** 两条节点看起来是不是同一条消息（不认编号，只认类型与开头文字）。 */
  function sameContent(a, b) {
    if (!a || !b || a === b) { return false; }
    const sig = (el) => Array.from(el.classList || []).filter((c) => c !== "msg-enter").sort().join(" ")
      + "\u0000" + ((el.dataset && typeof el.dataset.raw === "string" ? el.dataset.raw : (el.textContent || "")).slice(0, 120));
    return sig(a) === sig(b);
  }

  /** 窗格顶上那些不是消息的东西（重放不产它们，收尾也不能收）。 */
  function isPaneFixture(el) {
    return !!el && (el.classList.contains("history-more")
      || el.classList.contains("older-hint")
      || el.classList.contains("empty-hint")
      || el.classList.contains("session-loading"));
  }

  /** 重放开始（带编号）：不清空窗格，重置“正在长的那几样”，从这里开始按编号对账。 */
  function beginReconcile(st) {
    if (st.redrawTimer) { clearTimeout(st.redrawTimer); }
    // 上一轮对账还没收尾（两次重画叠在一起）：先把那一轮收掉，别让两个游标打架
    if (st.reconcile) { endReconcile(st); }
    releaseAnchorHold(st);
    st.redrawRestore = null;
    // 窗格顶上那几样不是消息（「加载更早」按钮 / 空提示 / 加载遮罩）：游标从第一条消息起，
    // 不然重放的每一条都插在按钮前面，按钮被一路挤到最底下
    let first = st.paneEl.firstChild;
    while (first && isPaneFixture(first)) { first = first.nextSibling; }
    st.reconcile = {
      cursor: first,
      // 第一条重放消息的位置以它自己为准（窗口模式下，重放是从“最近 20 条”开始的，
      // 前面那些更早的消息还该留在上面；游标要是从头起步，就会把重放的整批插到它们前面）
      alignNext: true,
      last: null,            // 这一遍最后一个放到位上的节点：它后面全是没重放到的旧节点
      pane: st.paneEl,       // 认准是哪一块窗格：往「加载更早」的暂存区渲染时不能动游标
      touched: new Set(),
      historyWindow: false,
      // 这一遍只是“最近一段”（更早的没发）：页面上比它更早的那些要收掉。
      // 为什么不留着：留着的话顶上那颗「加载更早」说的“还有 N 条”就跟页面对不上了，
      // 点一下会把同一批消息再插一遍。窗口模式只可能出现在“页面自己又要了一次重画”
      // 这种少见的路上（重连补不上 / 重画被打断那两种都发全量），收掉再点一下也不费事。
      windowStart: false,
    };
    // 位置由我们自己放（endReconcile）：先关掉浏览器那套滚动锚定，不然两边都补、视野往下漂
    st.paneEl.style.overflowAnchor = "none";
    st.anchorOverflowDisabled = true;
    // 重放期间先别跟着往下滚：几百条老消息一条一条往下拽，人就没法看了。
    // 位置还是要记一份：留着的那部分节点没动，但被换掉的那些（工具行）在视野上面时
    // 会把内容顶来顶去，浏览器自己那套滚动锚定在这种批量替换里也不靠谱。
    st.redrawRestore = takeScrollAnchor(st);
    st.suppressScroll = true;
    st.noCountPop = true;
    // 正插到一半的「加载更早」那批作废：它插进来的是旧节点，会跟这一遍对账打架
    if (st._stage) { st._stage = null; st._stageDropped = true; }
    st._historyBtn = null;
    // 这些东西重放里没有，是“现在这个状态”算出来的：先收掉，重放完按真实状态重算
    dropRunningLine(st);
    if (st.endHintRow) { st.endHintRow.remove(); }
    st.endHintRow = null;
    st.endHintEl = null;
    st.endHintStopEl = null;
    // 重放会一路重新攒这些游标：从现在起从零开始
    st.currentAssistant = null;
    st.thinkingEntry = null;
    st.pendingThink = null;
    st.segmentThinking = null;
    st.tailThinking = null;
    st.currentToolTail = null;
    st.toolGroups = null;
    st.toolGroupEntries.clear();
    st.pendingToolCards.clear();
    for (const tg of st.pendingToolTags.values()) { clearInterval(tg._timer); }
    st.pendingToolTags.clear();
    // 兜底：syncPoint 没等到也别一直不跟着走
    st.redrawTimer = setTimeout(() => { if (st.reconcile) { endReconcile(st); } }, 8000);
  }

  /** 重放完了：收掉这一遍没提到的旧节点，把位置与末尾那几样恢复成“现在”的样子。 */
  function endReconcile(st) {
    const rec = st.reconcile;
    if (!rec) { return; }
    st.reconcile = null;
    if (st.redrawTimer) { clearTimeout(st.redrawTimer); st.redrawTimer = null; }
    const pane = st.paneEl;
    // 全量重放：只从“这一遍最后一个放到位的节点”往后收（前面那些都是这一遍放好的）。
    // 只发了最近一段：整块窗格里没被认领的旧节点都收掉（见 beginReconcile 里的 windowStart）。
    let node = rec.windowStart ? pane.firstChild : (rec.last ? rec.last.nextSibling : pane.firstChild);
    while (node) {
      const next = node.nextSibling;
      if (!rec.touched.has(node) && !isPaneFixture(node)) { forgetUnit(st, node); }
      node = next;
    }
    // 这一遍没再来「加载更早」那条：说明这次发的是全部，按钮收掉（跟清空重画时一个结果）
    if (!rec.historyWindow) { setHistoryWindow(st, false, 0); }
    st.suppressScroll = false;
    st.noCountPop = false;
    syncEndHint(st);
    // 正在跑的那一条在对账开始时被收掉了：按真实状态重算一次（长命令跑着的时候它该在）
    syncRunningLine(st);
    // 贴底的人照旧跟到底；在中间看的人放回原来那条消息那儿
    const anchor = st.redrawRestore;
    st.redrawRestore = null;
    if (st.stickToBottom) { scrollToBottom(st, true); return; }
    const found = anchor ? findScrollAnchor(pane, anchor.candidates) : null;
    if (!found) { return; }
    st.hasNewContent = true;
    pane.scrollTop = Math.max(0, found.el.offsetTop - found.offset);
    st.lastScrollTop = pane.scrollTop;   // 记上：后面重挂会话时会按这个恢复
    syncJumpBottom(st);
    holdScrollOn(st, found.el);
  }

  /**
   * 不盯了：把窗格的“滚动锚定”还给浏览器（重画期间我们自己管位置，见 beginRedraw）。
   * 浏览器自己那套也会在“上面变高”时补一次，两边一起补就成了补两倍。
   */
  function releaseAnchorHold(st) {
    st.anchorHold = null;
    if (!st.anchorOverflowDisabled) { return; }
    st.anchorOverflowDisabled = false;
    st.paneEl.style.overflowAnchor = "";
  }

  // 用户主动接管滚动（滚轮/触屏/键盘向上）：立刻停掉 lerp 追底，交还控制权。
  // 流式中同步亮起“跳到最新”按钮；非流式不打扰（用户只是回看已结束的回复）。
  function userTookOverScroll(st) {
    if (!st.stickToBottom) { return; }
    st.stickToBottom = false;
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); st.lerpRafId = 0; }
    if (st.scrollRafId) { cancelAnimationFrame(st.scrollRafId); st.scrollRafId = 0; }
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

  // ==================== 你说过的话（输入框右边那颗按钮）====================
  // 那颗按钮一直露着（空会话里也点得开，点开说一句“你还没说过话”）。
  // 清单从输入行上头往上弹一张小的（输入框就在屏幕底，往下弹会顶到键盘、出屏幕），
  // 贴着按钮那一头（右边），一行一句，点一行就跳到那条（去的地方跟导航条一样，见 jumpToUserMessage）。
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
    // 摆在框底那条横排的右头（前头依次是新建会话那颗加号、模型那颗胶囊，见 renderHtml 的 #composer）
    row.appendChild(saidBtn);
    // 清单挂在框底那条横排里，但定位靠的是外头那个圆角盒子（#composer 是 relative，
    // 这条横排自己不定位）：bottom: 100% 就从盒子上头往上弹，不会盖住打字的地方。
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
    // 上面还有没画的老消息：先把它们都画出来。清单是从窗格里扒 `.msg.user` 的，
    // 少画一截就少几行（而且点进去也跳不到）。这是个明确的点击，卡一下可接受。
    while (st && st.older && st.older.length) { fillOlder(st, st.older.length); }
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
  function buildStreamBlock(token, sessionId) {
    const box = document.createElement("div");
    box.className = "md-block";
    const html = streamBlockHtml(token);
    if (html === null) { return null; }
    box.innerHTML = html;
    fixMdImages(box, sessionId);
    return box;
  }

  /** 一个块渲染成的 HTML；空格块给 null。 */
  function streamBlockHtml(token) {
    if (token.type === "space") { return null; }
    ensureMarkedHighlight();
    ensureFileLink();
    try {
      // 高亮那条插件把着色挂在 walkTokens 上（不是 renderer 里），而 `marked.parser` 不跑它：
      // 自己先跑一遍，流式里的代码块才有着色（整段渲染那条路由 marked.parse 自己跑）。
      if (marked.defaults.walkTokens) { marked.walkTokens([token], marked.defaults.walkTokens); }
      return marked.parser([token], mdOptions());
    } catch (e) { return escapedText(token.raw); }
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
  function syncStreamBlocks(st, cur, raw) {
    let state = cur.blocks;
    if (state && raw.length < state.rawLen) { state = null; }   // 正文变短（不是追加）：从头来
    if (!state) {
      cur.el.textContent = "";
      state = cur.blocks = { tokens: [], frozenCount: 0, frozenOffset: 0, els: [], rawLen: 0 };
    }
    const wasFrozen = state.frozenCount;

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
        tailEls.push(buildStreamBlock(tokens[i], st.id));
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
    // 刚定型的块里如果有 mermaid，现在画：定型之后内容不会再变，画出来不会变成残图。
    // 尾巴那两块先不动（内容随时会变），等它们定型、或者这一轮收尾（见 finalizeCurrentAssistant）。
    for (let i = 0; i < freeze - wasFrozen; i++) { decorateMermaid(tailEls[i]); }
    return true;
  }

  /** 渲染流式正文（按块；不能切块时回退整段重画）。 */
  function renderStreamBody(st, raw) {
    const cur = st.currentAssistant;
    cur.el.dataset.raw = raw;
    if (syncStreamBlocks(st, cur, raw)) { return; }
    cur.blocks = null;
    cur.el.innerHTML = renderMarkdown(raw);
    fixMdImages(cur.el, st.id);
    decorateMermaid(cur.el);
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
      // 最后那两块流式期间没画（还没定型）：这一轮结束了，收尾补上。
      decorateMermaid(st.currentAssistant.el);
      // 流式期间不给活跃消息挂符号链接（见 symbolSet 那段），收尾这里补上：
      // 不然要等下一次符号集合变化才可点。
      applySymbolLinks(st.currentAssistant.el);
      smoothScrollToBottom(st);
      st.currentAssistant = null;
      // 正文这一段吐完了、还没接上下一段（工具 / 想 / 再等）：动画换回「等」
      if (activeId === st.id) { syncStatus(); }
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

  /** 这条消息的时刻：鼠标停在正文上才露（跟原来的复制按钮一个位置，见 chat.css 的 .msg-time）。
   *  at 是那条消息的开始时刻（毫秒）；拿不到（老后端 / 历史里没带）就用现在。
   *  字写进 data-time、由 CSS 的 ::after 画：它不算正文的文字（选中复制、Ctrl+A、读屏都不带上它）。 */
  function attachMsgTime(div, at) {
    const ms = typeof at === "number" && at > 0 ? at : Date.now();
    const el = document.createElement("span");
    el.className = "msg-time";
    el.dataset.time = formatMsgTime(ms);   // 画出来靠 CSS 的 ::after（见 chat.css）
    el.title = formatFullTime(ms);
    div.appendChild(el);
  }

  /** 重放时同一条正文又画了一遍：时刻改成这次的值（没有这个 span 就补一个）。 */
  function updateMsgTime(div, at) {
    const el = div.querySelector(":scope > .msg-time");
    if (!el) { attachMsgTime(div, at); return; }
    const ms = typeof at === "number" && at > 0 ? at : Date.now();
    el.dataset.time = formatMsgTime(ms);
    el.title = formatFullTime(ms);
  }

  /** 时刻写成短的：今天只写时分（15:04），别的日子前面补日期（10-17 15:04），跨年的写全年。 */
  function formatMsgTime(ms) {
    const d = new Date(ms);
    const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    const now = new Date();
    if (d.toDateString() === now.toDateString()) { return hm; }
    if (d.getFullYear() === now.getFullYear()) { return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + hm; }
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + hm;
  }

  /** 鼠标停上去看的完整时刻（写进 title）：年-月-日 时:分:秒。 */
  function formatFullTime(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " "
      + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /**
   * 进场动画那颗类：重放老消息时不挂（后端给重放的那几条带 replay 标记，见 st.replayNow）。
   *
   * 为什么挂不得：重画一次几百条一起进来，每条都挂 250 毫秒的进场动画，浏览器要同时算几百条。
   * 量过（手机视口、4 倍降速，同一页面交替跑、每组 5 轮取中位数，这一轮含之后 1.6 秒的主线程）：
   *   200 条：944 → 1466 毫秒；400 条：2144 → 2672 毫秒。
   * 老消息本来就在上面，进场给谁看。
   */
  function enterCls(st) { return st.replayNow ? "" : " msg-enter"; }

  function addPlain(st, cls, role, text, id) {
    hideEmptyHint(st);
    st.currentToolTail = null; // 新消息块：工具标签另起一行，不往上一段后面续
    endRunningLine(st);       // 这一批工具过去了：还在留的那条位置到此为止（见 endRunningLine）
    const content = text || "";
    const key = typeof id === "string" && !isStageRender(st) ? id : "";
    let known = key ? st.byId.get(key) : null;
    // 编号对上了还得是同一类东西：历史被改写（压缩 / 回滚 / 换分支）之后，同一个编号可能
    // 落到另一条消息上，不核对就会把助手正文灌进用户气泡里
    if (known && known.dataset.midKind !== cls) { st.byId.delete(key); known = null; }
    if (known) {
      // 重放时同一条消息又来了：节点原地留着，只有文字变了才重画里面的内容
      if (known.dataset.raw !== content) {
        known.dataset.raw = content;
        known.innerHTML = "";
        if (cls === "user" && shouldFoldText(content)) {
          known.appendChild(makeLongTextBody(content));
        } else {
          const body2 = document.createElement("div");
          body2.textContent = content;
          known.appendChild(body2);
        }
      }
      placeUnit(st, known);
      scrollToBottom(st);
      return known.firstElementChild;
    }
    const div = document.createElement("div");
    div.className = "msg " + cls + enterCls(st);
    div.dataset.raw = content;
    if (cls === "user" && shouldFoldText(content)) {
      div.appendChild(makeLongTextBody(content));
    } else {
      const body = document.createElement("div");
      body.textContent = content;
      div.appendChild(body);
    }
    if (cls === "assistant") { attachMsgTime(div, null); }
    if (key) { div.dataset.mid = key; div.dataset.midKind = cls; st.byId.set(key, div); }
    placeUnit(st, div);
    scrollToBottom(st);
    return div.firstElementChild;
  }

  function addMarkdown(st, raw, at, id) {
    hideEmptyHint(st);
    st.currentToolTail = null; // 新正文块：工具标签另起一行，不往上一段后面续
    endRunningLine(st);       // 这一批工具过去了：还在留的那条位置到此为止（见 endRunningLine）
    const text = raw || "";
    const key = typeof id === "string" && !isStageRender(st) ? id : "";
    let known = key ? st.byId.get(key) : null;
    if (known && known.dataset.midKind !== "assistant") { st.byId.delete(key); known = null; }
    if (known) {
      const body2 = known.querySelector(".md") || known.firstElementChild;
      if (body2 && body2.dataset.raw !== text) {
        body2.dataset.raw = text;
        body2.innerHTML = renderMarkdown(text);
        fixMdImages(body2, st.id);
        decorateMermaid(body2);
      }
      // 时刻跟着这次重放的来（以前停在上一遍的旧值上）
      updateMsgTime(known, at);
      placeUnit(st, known);
      scrollToBottom(st);
      return body2;
    }
    const div = document.createElement("div");
    div.className = "msg assistant" + enterCls(st);
    const body = document.createElement("div");
    body.className = "md";
    body.dataset.raw = text;
    body.innerHTML = renderMarkdown(text);
    fixMdImages(body, st.id);
    decorateMermaid(body);
    attachMsgTime(div, at);
    div.appendChild(body);
    if (key) { div.dataset.mid = key; div.dataset.midKind = "assistant"; st.byId.set(key, div); }
    placeUnit(st, div);
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
    // 还得真是那条 .tool-row：这一批的落脚点可能是刚铺在它下面的一块图（见 mountToolImageBlock），
    // 新标签不能往那上面挂，得另起一行排在图下面。
    if (!isToolRow(st.currentToolTail) || st.currentToolTail.parentElement !== st.paneEl) {
      st.currentToolTail = document.createElement("div");
      st.currentToolTail.className = "msg tool-row" + enterCls(st);
      placeUnit(st, st.currentToolTail);
    }
    return st.currentToolTail;
  }

  /** 这个节点是不是一条工具调用行（这一批的落脚点也可能是图块，见 toolTagHost）。 */
  function isToolRow(el) {
    return !!el && el.classList.contains("tool-row");
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
  /** 没有结果、而且也不会再有了（那一轮被中断 / pi 进程没了）：提示框里写这一句。 */
  const INTERRUPTED_NOTE = "（这一轮被中断，没有结果）";
  /** 模型的思考也算这一批里的一种条目：名字固定叫这个（不并进 NO_MERGE_TOOLS：同名照常合并）。 */
  const THINKING_NAME = "think";

  function addTool(st, toolName, argStr, toolCallId, interrupted) {
    hideEmptyHint(st);
    if (!NO_MERGE_TOOLS.has(toolName)) {
      return addToolToGroup(st, toolName, argStr, toolCallId, null, interrupted);
    }
    const tag = document.createElement("span");
    // 还在跑的才转圈：没有 id 的静态调用没有结果事件；被中断的那条结果永远不会来（见 settleInterruptedTools）
    const running = !!toolCallId && !interrupted;
    tag.className = "tool" + (running ? " running" : "");
    tag.insertAdjacentHTML("afterbegin", GEAR_SVG);
    tag.appendChild(document.createTextNode(" " + toolName));
    // 悬浮提示显示调用与结果（见 showTagTip）；read 读图的结果也在提示框里出图。
    tag._toolName = toolName;
    tag._toolCallId = toolCallId || "";
    tag._argStr = argStr;
    tag._resultText = interrupted ? INTERRUPTED_NOTE : "";
    tag._resultMeta = {};
    tag._isError = false;
    tag._done = !running;
    // 开始时刻（重放历史里的老调用记 0，不写耗时，见 runningCalls）
    tag._startedAt = st.noCountPop ? 0 : Date.now();
    // 提示内容：运行中显示调用参数（输入）；结果到达后由 setTagTip 填入全部原文（输出）。
    // 带图片的结果（read 读图这类）不走提示框：结果到了会把这个标签整个换成对话里的一块图，
    // 见 mountToolImageBlock。
    tag._tipCall = tagTipCallText(toolName, argStr);
    tag._tipBody = interrupted ? INTERRUPTED_NOTE : "";
    tag._st = st;
    attachTagTipHandlers(tag);
    mountToolTag(st, tag);
    // 问话卡片有时候比这条工具行先到（两条通道各有快慢）：把它挪到这一行下面
    dockAskCardToRow(st, toolCallId, tag.parentElement);
    if (running) { st.pendingToolTags.set(toolCallId, tag); }
    syncRunningLine(st);   // 这条在跑：末尾那行跟着写上它
    scrollToBottom(st);
    return tag;
  }

  /** 往这一批里加一条调用：同名就并到已有那个标签上（标签停在第一次调用的位置），
   *  没见过的名字新开一个标签。tipFill（可选）：这一条在提示框里怎么画，不传就按默认的
   *  「调用一行 + 结果一块」画（write / edit 自带一块，见 buildEditCard）。
   *  interrupted：这条已经中断了、结果永远不会来（重放历史时由后端标出来）。 */
  function addToolToGroup(st, toolName, argStr, toolCallId, tipFill, interrupted) {
    const row = toolTagHost(st);
    let batch = st.toolGroups;
    if (!batch || batch.row !== row) {
      batch = { row, byName: new Map() };
      st.toolGroups = batch;
    }
    let g = batch.byName.get(toolName);
    if (!g || g.tag.parentElement !== row) {
      const tag = document.createElement("span");
      // 思考那颗标签自己带个名字：它是唯一会转圈的标签（见 chat.css 的 .tool-think.running）
      tag.className = "tool tool-group" + (toolName === THINKING_NAME ? " tool-think" : "");
      tag.insertAdjacentHTML("afterbegin", GEAR_SVG);
      const nameEl = document.createElement("span");
      nameEl.className = "tg-name";
      const countEl = document.createElement("span");
      countEl.className = "tg-count";
      tag.appendChild(nameEl);
      tag.appendChild(countEl);
      // 合并标签上不挂单条结果（_toolName / _resultText 那一套）：每条的数据都在 g.entries 里
      // plusAt / plusEl：这条标签上「+1」小动画的上一次时间与正在飘的那个（见 popPlusOne）
      g = { row, tag, nameEl, countEl, name: toolName, entries: [], plusAt: 0, plusEl: null, st };
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
      resultText: interrupted ? INTERRUPTED_NOTE : "",
      meta: {},
      isError: false,
      // 无 id 的静态调用无结果事件；被中断的那条也是——结果永远不会来（见 settleInterruptedTools）
      done: !toolCallId || !!interrupted,
      // 这条从什么时候开始跑的（毫秒）：「正在跑的那一条」后面那个耗时拿它算（见 runningCalls）。
      // 重放历史里的老调用（noCountPop）不知道它当时什么时候开始的：记 0，那种就不写耗时。
      startedAt: st.noCountPop ? 0 : Date.now(),
    };
    g.entries.push(entry);
    if (toolCallId && !interrupted) { st.toolGroupEntries.set(toolCallId, entry); }
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
      let showResult = true;
      if (e.done) {
        res.className = "tag-tip-result";
        // 内容整个没带过来的（后端只留了“一共多少字”）：不写“（没有输出）”，也不出这块，
        // 下面那行小字会说清楚（见 appendClipNote）
        // 思考没有字（模型只给了加密内容：pesai 那些会话里这样的一大堆）：说清是没字，不是没输出
        res.textContent = e.resultText
          || (e.clip ? "" : (e.name === THINKING_NAME ? "（这段思考没有文字）" : "（没有输出）"));
        showResult = !!res.textContent;
      } else if (e.resultText) {
        // 还在跑、但已经拿到部分结果（toolResultUpdate）：先把拿到的部分显示出来
        res.className = "tag-tip-result tip-loading";
        res.textContent = e.resultText;
      } else {
        res.className = "tag-tip-result tip-loading";
        res.textContent = GROUP_RUNNING_TEXT;
      }
      if (showResult) { content.appendChild(res); }
      appendClipNote(content, e.clip);
    });
  }

  /** 结果带图（read 读图这类）：把这一条从合并组里摘出去，在对话里铺成一整块图。
   *  图插在这条调用所在那一排工具行的位置上（见 mountToolImageBlock）；组被摘空了就连标签带那条工具行
   *  一起收掉，后面的调用会另起一行、另起一组，排在图下面。 */
  function removeEntryFromGroup(st, entry, images) {
    const g = entry.group;
    const row = g.row;   // 摘之前先记下这一排：图要插在它的位置上
    const i = g.entries.indexOf(entry);
    if (i >= 0) { g.entries.splice(i, 1); }
    st.toolGroupEntries.delete(entry.id);
    if (g.entries.length === 0) {
      g.tag.remove();
      const batch = st.toolGroups;
      if (batch && batch.byName.get(g.name) === g) { batch.byName.delete(g.name); }
      syncRunningLine(st);
    } else {
      syncGroupTag(st, g);
    }
    // 先插图、再收掉空了的那条行：顺序反过来（先把行收掉）就找不着图该待的地方了
    mountToolImageBlock(st, { toolName: entry.name, argStr: entry.argStr, tipCall: entry.tipCall, toolCallId: entry.id, row: row }, images);
    dropToolRow(st, row);
  }

  /** 还在转圈的调用到此为止：结果不会来了（那一轮被中断、或者 pi 进程没了）。
   *  ids 给了就只收这几条，不给就把这个会话里所有还挂着的都收掉（见后端发来的 toolsInterrupted）。
   *  收掉的样子跟“正常拿到结果”一样：不再转圈，提示框里写一句「这一轮被中断，没有结果」。 */
  function settleInterruptedTools(st, ids) {
    const want = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
    const groups = new Set();
    for (const [id, entry] of Array.from(st.toolGroupEntries.entries())) {
      if (want && !want.has(id)) { continue; }
      entry.done = true;
      entry.resultText = INTERRUPTED_NOTE;
      st.toolGroupEntries.delete(id);
      if (entry.group) { groups.add(entry.group); }
    }
    for (const g of groups) { syncGroupTag(st, g); }   // 转圈跟着重算（里面会再叫一次 syncRunningLine）
    for (const [id, tag] of Array.from(st.pendingToolTags.entries())) {
      if (want && !want.has(id)) { continue; }
      tag.classList.remove("running");
      tag._done = true;
      tag._resultText = INTERRUPTED_NOTE;
      tag._resultMeta = {};
      st.pendingToolTags.delete(id);
      setTagTip(tag, INTERRUPTED_NOTE, "");
    }
    syncRunningLine(st);
  }

  // ==================== 正在跑的那一条 ====================
  // 工具标签只说得出工具名：命令行、读哪个文件、grep 找什么都在提示框里，不悬浮就看不见。
  // 正在跑的那一条不一样：它在当前这批标签下面单占一行，把这一行的摘要直接写出来
  // （bash 就是「$ 命令」）。一长串命令只写核心那一段、后面灰一个「+N」，整条在悬浮提示里看
  // （怎么挑核心见下面「一长串命令里的核心那一段」）。同时跑几条也只露一条 —— 只露最近开始的那条。
  // 为什么不排成几行：几条一起跑时，先跑完的那条一收，这一块就矮一行，下面的东西跟着
  // 上下跳一下（贴着底看的时候特别明显）。行数永远是 0 或 1，就没有这一下。
  // 不出这行的两种：think（思考，内容在提示框里看）与 ask_choice（问话卡片本来就铺在消息流里，
  // 而且它要等人答完才算跑完，摆一行「正在跑」只会碍事）。
  //
  // 跑完了字不走 —— 一串很快跑完的调用（读文件、grep，一条几十毫秒）不该让这行一闪一闪
  // （出现、消失、又出现，下面的内容跟着上下跳）；而且这条命令本身（工具标签上只有名字）就在这儿
  // 看得到，一下子没了就看不成了。所以一条都不在跑之后这条留着、只是冻住：齿轮停转、
  // 耗时定在跑完那一刻（见 freezeRunningLine），一直到新的命令原地把它顶掉。
  // 整条（字与位置）在这一批过去时一并收掉：下面出了正文 / 问话卡片，或者这一轮跑完
  // （见 endRunningLine）。
  //
  // 一行写不完的（长命令行）：字自己慢慢横向滚，只往一个方向（从头滚到末尾，两端各停半秒再从开头来，
  // 见 rollRunningText 与 chat.css 的 tr-roll），不然一颗「bash」加小半条命令就完了，看不出来在跑什么。
  const RUNNING_LINE_SKIP = new Set([THINKING_NAME, "ask_choice"]);
  const RUNNING_ROLL_MIN_PX = 4;    // 溢出这几个像素以内不算「放不下」（末尾省略号那点宽度，不值当滚）
  const RUNNING_ROLL_SPEED = 30;    // 放不下的那行字自己滚动的快慢：每秒 30 像素（慢慢地滚）
  // 两头各停多久（毫秒）：固定时间，不随命令长短变。以前是按「一趟的百分之几」算的，
  // 一趟多长又按长度算（每秒 30 像素），于是命令越长开头死得越久：一千字的命令一趟三分钟，
  // 前六秒多一个像素都不走（真机上就是这个「一动不动」）。量法与数据见 dev/runningLine.js。
  const RUNNING_ROLL_HOLD_MS = 500;
  const RUNNING_CLOCK_MS = 200;     // 后面那个耗时的刷新快慢（一秒里刷五回就够看着在走）

  // ==================== 一长串命令里的核心那一段 ====================
  // 模型爱写一长串：cd 到某个目录 && 跑个脚本 | sed 看头几行。整条摆在「正在跑」那一行上，
  // 一眼看不出在干什么（一行放不下还得横着滚半天）。这里只按字面把命令切成几段，把「正经干活」的那段挑出来：
  //   · 挪位置的（cd / pushd / popd）、打杂的（echo / export / sleep / true …）不算事；
  //   · 挂在管道后面、只修输出的（sed / head / tail / cut / sort / wc …）不算事；
  //   · 剩下的头一段就是核心（grep / jq / awk / xargs 不当作修输出的：它们常常就是查的东西本身）。
  // 分不出核心（只有一段、或者全被打杂的占满）就照原样整条写出来。
  // 命令只是一行字，这么切只是猜：整条一直留着，悬浮那一行就能看（见 syncRunningLine）。
  const SEG_PROG_SKIP = new Set(["sudo", "time", "env", "nohup", "command", "exec", "builtin", "nice", "!", "{", "do", "then", "else", "elif", "if", "while", "until"]);
  const SEG_NOISE = new Set(["cd", "pushd", "popd", "echo", "printf", "export", "unset", "set", "true", "false", ":", "sleep", "wait", "clear", "sync",
    "continue", "break", "exit", "return", "shift", "local", "declare", "readonly", "umask", "dirs"]);
  const SEG_PIPE_TAIL = new Set(["sed", "head", "tail", "cut", "sort", "uniq", "wc", "tr", "tee", "column", "less", "more", "nl", "fmt", "tac", "rev", "fold", "paste"]);
  // 只翻看一眼的（ls / cat / wc / head …）：有正经干活的段时它们不抢核心，
  // 一条正经活都没有（就 dd 看一眼、数数行）才轮得到它们（见 pickCoreSegment）
  const SEG_GLANCE = new Set(["ls", "cat", "wc", "head", "tail", "file", "stat", "du", "tree", "pwd", "which", "where", "type", "readlink"]);
  // 框架词：单独占一段时它就是 for / if 那套的骨头，不是一件活（`done`、`fi` 曾被当成核心写出来过）
  const SEG_FRAME = new Set(["do", "then", "else", "elif", "fi", "done", "esac", "in", "{", "}", "(", ")"]);
  // 条件判断本身（`[ -f "$f" ]` / `test …`）：算「只翻一眼」那档 —— 循环体里它后面往往才是真干活
  const SEG_CHECK = new Set(["[", "[[", "test"]);
  // 段首是这些词的（for / if / while 那一套的开头）本身不是一件事
  const SEG_LOOP_HEAD = new Set(["for", "while", "until", "select"]);
  const SEG_COND_HEAD = new Set(["if", "case"]);
  // 显示时从段首剥掉的：框架词（「do python x.py」写成「python x.py」、「if grep …」写成「grep …」）
  const SEG_DISPLAY_STRIP = new Set(["do", "then", "else", "elif", "!", "{", "if", "while", "until", "for", "case", "select"]);

  /** 这一行的收尾标记（heredoc 的 `<<EOF`）：`<<` 后面那个词，引号去掉、`<<-` 的前导 tab 也认。
   *  不是 heredoc（`<<<` 是 herestring、或者后面没东西）就返回空。 */
  function heredocDelim(s, i) {
    if (s[i + 2] === "<") { return ""; }          // <<< 不是 heredoc
    let j = i + 2;
    if (s[j] === "-") { j++; }
    while (s[j] === " " || s[j] === "\t") { j++; }
    let word = "";
    while (j < s.length && !/[\s;&|<>]/.test(s[j])) { word += s[j++]; }
    return word.replace(/^["'\\]|["'\\]$/g, "");
  }

  /** 从 p（heredoc 正文第一行的开头）吃到收尾那一行：正文里的东西一个字都不是命令（一段脚本、一份数据）。
   *  返回正文原文与收尾行结尾的位置（`next` 就是那行的换行符，或者到了末尾）；找不到收尾行就吃到末尾。 */
  function takeHeredocBody(s, p, delim) {
    let at = p;
    while (at < s.length) {
      let end = s.indexOf("\n", at);
      if (end < 0) { end = s.length; }
      // 收尾行：整行就是那个标记（`<<-` 允许前面有 tab；行尾的 \r 不算）
      const line = s.slice(at, end).replace(/\r$/, "").replace(/^\t+/, "").trimEnd();
      if (line === delim) { return { text: s.slice(p, end), next: end }; }
      at = end + 1;
    }
    return { text: s.slice(p), next: s.length };
  }

  /** 按顶层分隔符（&& || ; | & 换行）把一条命令切成几段：引号里、括号里、heredoc 正文里的不算。
   *  每段带 sepBefore —— 它前面是什么分隔开的（挑核心时要用：管道后面跟上来的才算“修输出”）。 */
  function splitCommandSegments(cmd) {
    const out = [];
    const s = String(cmd || "");
    let cur = "", pendingSep = "", quote = "", depth = 0;
    // 这一行上挂着的 heredoc 收尾标记（`cat <<A <<B` 会有两个，按顺序吃）：
    // 有它就不能拿换行当分隔符 —— 下面是那段正文，一直到单独一行就是它为止
    const heredocs = [];
    const flush = () => {
      const text = cur.trim();
      cur = "";
      if (!text) { return; }
      out.push({ text, sepBefore: pendingSep });
      pendingSep = "";
    };
    const cut = (sep) => { flush(); pendingSep = sep; };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], next = s[i + 1] || "", prev = i > 0 ? s[i - 1] : "";
      if (quote) {
        cur += ch;
        if (ch === quote) { quote = ""; }
        else if (ch === "\\" && quote === '"' && next) { cur += s[++i]; }
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if (ch === "\\" && next) { cur += ch + s[++i]; continue; }
      if (ch === "(") { depth++; cur += ch; continue; }
      if (ch === ")") { if (depth > 0) { depth--; } cur += ch; continue; }
      if (depth > 0) { cur += ch; continue; }
      if (ch === "<") {
        const delim = heredocDelim(s, i);
        if (delim) { heredocs.push(delim); }
      }
      if (ch === "\n" && heredocs.length) {
        // 接下来这几块是正文：原样吃进来，一个字都不切
        let at = i + 1;
        while (heredocs.length) {
          const got = takeHeredocBody(s, at, heredocs.shift());
          cur += (cur.endsWith("\n") ? "" : "\n") + got.text;
          at = got.next;
          if (at >= s.length) { break; }
          at += 1;   // 跳过收尾行的换行，接着吃下一个 heredoc 的正文
        }
        cut(";");
        i = at - 1;
        continue;
      }
      if (ch === ";" || ch === "\n") { cut(";"); continue; }
      if (ch === "|") {
        if (next === "|") { cut("||"); i++; continue; }
        if (next === "&") { cut("|"); i++; continue; }   // |& 也是管道
        cut("|"); continue;
      }
      if (ch === "&") {
        if (next === "&") { cut("&&"); i++; continue; }
        if (next === ">") { cur += ch; continue; }                     // &> 重定向
        if (prev === ">" || prev === "<") { cur += ch; continue; }    // 2>&1、>&2
        if (next && !/\s/.test(next)) { cur += ch; continue; }         // a&b 这种少见写法别乱切
        cut("&"); continue;
      }
      cur += ch;
    }
    flush();
    return out;
  }

  /** 这一段跑的是哪个程序：跳过前面的环境变量赋值（FOO=1）与 sudo / time 这类前缀，
   *  取第一个词，带路径的只留文件名。 */
  function segmentProgram(text) {
    for (const raw of String(text || "").trim().split(/\s+/)) {
      const w = raw.replace(/^["']+|["']+$/g, "");
      if (!w) { continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { continue; }
      if (SEG_PROG_SKIP.has(w)) { continue; }
      const base = w.replace(/^.*[\\/]/, "");
      if (SEG_PROG_SKIP.has(base)) { continue; }
      return base;
    }
    return "";
  }

  /** 这一段开头的那个词（认 do / then / done / fi / if / [ 这些框架用；前面挂的（ { ! 先剥掉）。 */
  function segmentHeadWord(text) {
    const m = /^[({!\s]*([^\s]+)/.exec(String(text || ""));
    return m ? m[1].replace(/[)};]+$/, "") : "";
  }

  /** 这一段值多少（挑核心时用）：2 = 正经干活；1 = 只翻看一眼（ls / cat / wc / [ 这类）；
   *  0 = 不算事（挪位置的、打杂的、管道后面修输出的、for / if 那套的骨头）。
   *  判之前先把段首的框架词剥掉：`do if grep …` 里真正干活的是 grep，不是 do。 */
  function segmentRank(seg, i) {
    const rawHead = segmentHeadWord(seg.text);
    // for / while / case 的循环头本身不是一件活（剥掉 for 只剩个变量名）
    if (SEG_LOOP_HEAD.has(rawHead) || rawHead === "case" || rawHead === "function") { return 0; }
    const body = segmentDisplay(seg.text);
    const head = segmentHeadWord(body);
    if (!body || SEG_FRAME.has(head)) { return 0; }
    const prog = segmentProgram(body);
    if (!prog || SEG_NOISE.has(prog)) { return 0; }
    if (i > 0 && seg.sepBefore === "|" && SEG_PIPE_TAIL.has(prog)) { return 0; }
    if (SEG_CHECK.has(head) || SEG_GLANCE.has(prog)) { return 1; }
    return 2;
  }

  /** 挑核心段：先找正经干活的那段（2 分）；一条都没有，才退到「只翻看一眼」的那段（1 分）。
   *  同样值的取头一个 —— 所以「ls 一眼、再 grep 真查」挑出来的是 grep，
   *  「ls 一眼、再 wc -l 数行数」两条都只值一分，还是挑头一个。 */
  function pickCoreSegment(segs) {
    let best = -1, bestRank = 0;
    for (let i = 0; i < segs.length; i++) {
      const rank = segmentRank(segs[i], i);
      if (rank > bestRank) {
        bestRank = rank;
        best = i;
        if (rank === 2) { break; }   // 2 分到顶了：头一个正经干活的就够了
      }
    }
    return best < 0 ? null : segs[best];
  }

  /** 这一段写在那一行上长什么样：剥掉段首那几个连接词（do / then / ! …）；
   *  带 heredoc 正文的那种只写头一行（下面那一整块是脚本 / 数据，不是命令，整条在提示里看）。 */
  function segmentDisplay(text) {
    let out = String(text || "").trim();
    for (;;) {
      const m = /^(\S+)\s+([\s\S]*)$/.exec(out);
      if (!m || !SEG_DISPLAY_STRIP.has(m[1])) { break; }
      out = m[2].trim();
    }
    const nl = out.indexOf("\n");
    return nl < 0 ? out : out.slice(0, nl).trim();
  }

  /** bash 调用里那条命令原文（参数是 JSON 字符串）。 */
  function bashCommandOf(argStr) {
    try {
      const a = JSON.parse(argStr || "");
      return a && typeof a.command === "string" ? a.command : "";
    } catch (e) { return ""; }
  }
  /** 「正在跑」那一行写什么：一长串 bash 命令只写核心那一段（后面灰一个「+N」），
   *  整条留在这一行的悬浮提示里（trimmed=true 说明有字没写出来，得给个提示）。分不出来就照原样写。 */
  function runningLineText(call) {
    const whole = call.text || call.name || "";
    const oneLine = (text) => {
      const nl = text.indexOf("\n");
      return nl < 0 ? text : text.slice(0, nl).trim();
    };
    const asIs = () => {
      const main = oneLine(whole);   // 多行的那种（heredoc 脚本）只写头一行，其余在提示里
      return { main, more: "", trimmed: main !== whole };
    };
    if (call.name !== "bash") { return asIs(); }
    const cmd = bashCommandOf(call.argStr);
    const segs = splitCommandSegments(cmd);
    if (!segs.length) { return asIs(); }
    // 只有一段就用那一段（哪怕它是 cd / echo）；好几段才挑「正经干活」的那段
    const core = segs.length > 1 ? pickCoreSegment(segs) : segs[0];
    if (!core) { return asIs(); }
    // 整条摘要里 "$ " + 命令 后面那点尾巴（timeout 这类）照旧跟着写
    const head = "$ " + cmd;
    const tail = whole.startsWith(head) ? whole.slice(head.length).trim() : "";
    const main = "$ " + segmentDisplay(core.text) + (tail ? " " + tail : "");
    const more = segs.length > 1 ? "+" + (segs.length - 1) : "";
    return { main, more, trimmed: !!more || main !== whole };
  }

  /** 现在还有哪些调用在跑、各自那一行摘要与开始时刻（一条一行，按页面上标签的顺序）。
   *  直接看页面上那些转圈的标签：批次换了行、重放历史都不影响 —— 写出来的跟看到的是同一份。
   *  startedAt 是这条开始的时刻（毫秒）；0 表示不知道（重放历史里的老调用，见 addToolToGroup）——
   *  那种就不写耗时，不然会从屏幕刚打开那一刻开始数。 */
  function runningCalls(st) {
    const out = [];
    for (const tag of st.paneEl.querySelectorAll(".tool.running")) {
      const g = tag._tipGroup;
      if (g) {
        for (const e of g.entries) {
          if (!e.done && !RUNNING_LINE_SKIP.has(e.name)) {
            out.push({ text: e.tipCall || e.name, startedAt: e.startedAt || 0, id: e.id || "", name: e.name || "", argStr: e.argStr || "" });
          }
        }
        continue;
      }
      if (tag._done === false && !RUNNING_LINE_SKIP.has(tag._toolName)) {
        out.push({
          text: tag._tipCall || tag._toolName || "",
          startedAt: tag._startedAt || 0,
          id: tag._toolCallId || "",
          name: tag._toolName || "",
          argStr: tag._argStr || "",
        });
      }
    }
    return out;
  }

  /** 几条同时在跑时露哪一条：最近开始的那条（按开始时刻；重放出来的老调用没有开始时刻，
   *  都算 0，那就取页面上排最后那条）。 */
  function shownRunningCall(calls) {
    let best = calls[0];
    for (const c of calls) { if ((c.startedAt || 0) >= (best.startedAt || 0)) { best = c; } }
    return best;
  }

  /** 画/更新「正在跑」的那一行：贴在当前这批工具标签下面（新一轮工具行上来就跟着挪过去）。
   *  一条都不在跑了就把它冻住（字留着，见 freezeRunningLine）。 */
  function syncRunningLine(st) {
    // 往暂存区补更早的历史时（「加载更早」那批）不碰：那块还没在页面上（同 placeEndHint）
    if (!st || !st.paneEl || st._stage === st.paneEl) { return; }
    const calls = runningCalls(st);
    if (!calls.length) {
      // 一条都不在跑了：留在页面上的那条冻住（本来就没这条的什么都不用做）
      freezeRunningLine(st);
      return;
    }
    const call = shownRunningCall(calls);
    const line = st.runningLine;
    // 露的还是同一条（同行里别的跑完了、或者又起了一条都不管）：一个字都不动。
    // 重画一遍会把字横向滚的动画从头开始，这一块的高度也会抖一下 —— 正是要躲的。
    const key = (call.startedAt || 0) + "\u0000" + call.text;
    const shownItem = line ? line.firstElementChild : null;
    if (shownItem && st.runningKey === key && !shownItem.classList.contains("done")) {
      placeRunningLine(st, line);   // 位置仍要跟住这一批（正文之后又开了一批标签就挪过去）
      startRunClock(st);
      return;
    }
    st.runningKey = key;
    if (!line) {
      st.runningLine = document.createElement("div");
      st.runningLine.className = "msg tool-running";
    }
    const el = st.runningLine;
    el.textContent = "";
    const item = document.createElement("div");
    item.className = "tool-running-item";
    item.insertAdjacentHTML("afterbegin", GEAR_SVG);
    const t = document.createElement("span");
    t.className = "tr-text";
    const shown = runningLineText(call);
    t.textContent = shown.main;
    item.appendChild(t);
    // 只写了核心那一段：后面灰一个「+N」（这一句不跟着滚，一直看得见）
    if (shown.more) {
      const more = document.createElement("span");
      more.className = "tr-more";
      more.textContent = shown.more;
      item.appendChild(more);
    }
    if (shown.trimmed) {
      // 有字没写出来（只写了核心那一段 / 脚本只写了头一行）：整条语句在悬浮提示里看
      item._tipCall = call.text;
      item._tipBody = "";
      attachTagTipHandlers(item);
    }
    // 这条是 bash 命令：给一颗「放后台」（点了就不在这儿等它跑完，命令转到后台接着跑）。
    // 只有 browser 页面里能点：插件里的对话面板没有文件侧边栏，看不到后台清单；
    // 而且那边一关会话，命令的后台状态就没处看了。
    if (call.name === "bash" && call.id && fileSidebar.root) {
      const detach = document.createElement("button");
      detach.type = "button";
      detach.className = "tr-act";
      detach.textContent = "放后台";
      detach.title = "不在这里等它跑完：转到后台接着跑，跑完自动把结果交回本会话";
      detach.addEventListener("click", (e) => {
        e.stopPropagation();
        detach.disabled = true;
        detach.textContent = "转后台中…";
        vscode.postMessage({ type: "bashDetach", sessionId: st.id, toolCallId: call.id });
      });
      item.appendChild(detach);
    }
    // 这条跑了多久：钉在这一条末尾（字自己滚的时候它不动，见 chat.css 的 tr-time）。
    // 重放出来的老调用没有开始时刻：干脆不添那个位置（see runningCalls）
    if (call.startedAt) {
      const time = document.createElement("span");
      time.className = "tr-time";
      time._startedAt = call.startedAt;
      time.textContent = formatElapsed(Date.now() - call.startedAt);
      item.appendChild(time);
    }
    el.appendChild(item);
    placeRunningLine(st, el);
    startRunClock(st);
    // 量「这一行放不放得下」得等它排到页面上（新起一条时上面那一步才把它插进去），
    // 所以挪完位置再看一眼：放不下的改成自己滚（见 rollRunningText）。
    rollRunningText(t, el);
  }

  /** 那条「正在跑」上后面那个耗时：每 RUNNING_CLOCK_MS 重写一次（只动那几个数字，不动字、
   *  不重排这一条），所以字自己横向滚的时候耗时不动。 */
  function startRunClock(st) {
    if (st.runClock) { return; }
    st.runClock = setInterval(() => {
      const line = st.runningLine;
      if (!line) { stopRunClock(st); return; }
      for (const el of line.querySelectorAll(".tr-time")) {
        if (el._startedAt) { el.textContent = formatElapsed(Date.now() - el._startedAt); }
      }
    }, RUNNING_CLOCK_MS);
  }
  function stopRunClock(st) {
    if (!st || !st.runClock) { return; }
    clearInterval(st.runClock);
    st.runClock = 0;
  }

  /** 跑了多久写成短的：十秒以内留一位小数（1.2s，看着它在走），一分钟以内写整秒（37s），
   *  再长写「1分05秒」、一小时往上写「1时02分」。 */
  function formatElapsed(ms) {
    const ms0 = ms > 0 ? ms : 0;
    if (ms0 < 10000) { return (ms0 / 1000).toFixed(1) + "s"; }
    const sec = Math.floor(ms0 / 1000);
    if (sec < 60) { return sec + "s"; }
    const min = Math.floor(sec / 60);
    if (min < 60) { return min + "分" + (sec % 60 < 10 ? "0" : "") + (sec % 60) + "秒"; }
    return Math.floor(min / 60) + "时" + (min % 60 < 10 ? "0" : "") + (min % 60) + "分";
  }

  /** 这一条的字一行放得下就不动（末尾不够就省略号）；放不下就让它自己慢慢横向滚：
   *  滚的距离就是溢出的那些像素（--tr-shift），一趟多长由「走的那段每秒 30 像素 + 两头各停
   *  RUNNING_ROLL_HOLD_MS」算出来（--tr-dur），停顿的写法见下一条。
   *  进来时 .tr-text 里已经写好了（可能还带一个灰色小尾巴以外的东西，见 syncRunningLine）：
   *  这里只把它那几块整体挪进滚动那一层，一个字的样式都不变。 */
  function rollRunningText(t, line) {
    t.classList.remove("roll");
    t.style.removeProperty("--tr-shift");
    t.style.removeProperty("--tr-dur");
    dropRollKeyframes(line);   // 上一条命令那份 keyframes（换一条就不用了）
    const over = t.scrollWidth - t.clientWidth;
    if (over < RUNNING_ROLL_MIN_PX) { return; }
    const run = document.createElement("span");
    run.className = "tr-run";
    while (t.firstChild) { run.appendChild(t.firstChild); }
    t.appendChild(run);
    t.classList.add("roll");
    const dur = over / RUNNING_ROLL_SPEED * 1000 + RUNNING_ROLL_HOLD_MS * 2;
    t.style.setProperty("--tr-shift", -over + "px");
    t.style.setProperty("--tr-dur", dur / 1000 + "s");
    run.style.animationName = writeRollKeyframes(line, RUNNING_ROLL_HOLD_MS, dur);
  }

  // 页面上一时只露着一条「正在跑」（每会话一条），但几个会话各自都可能有：所以 keyframes
  // 一条一份、名字带编号，换命令 / 收掉这条时把自己那份删了，页面上不会攒一堆。
  let runningRollKeySeq = 0;

  /** 给这一条写一份 keyframes：两头的停顿在 keyframes 里只能写成「一趟的百分之几」，
   *  要停固定的毫秒数就得按这一条的一趟时长换算（所以要一条一份）。
   *  三格：0% 与 X% 都停在开头（= 停顿），到 (100-X)% 走到末尾，之后一直停在那里直到 100%。
   *  返回这份 keyframes 的名字（调用方把它挂到滚字的那层上）。 */
  function writeRollKeyframes(line, holdMs, durMs) {
    const pct = Math.min(45, Math.max(0.001, holdMs / durMs * 100));
    const name = "tr-roll-" + (++runningRollKeySeq);
    const style = document.createElement("style");
    style.textContent = "@keyframes " + name + "{0%{transform:translateX(0)}"
        + pct.toFixed(3) + "%{transform:translateX(0)}"
        + (100 - pct).toFixed(3) + "%{transform:translateX(var(--tr-shift,0px))}}";
    document.head.appendChild(style);
    if (line) { line._rollKeys = style; }
    return name;
  }

  /** 把这一条那份 keyframes 收掉（这条不再需要滚了 / 换了一条命令 / 整条收掉了）。 */
  function dropRollKeyframes(line) {
    if (!line || !line._rollKeys) { return; }
    line._rollKeys.remove();
    line._rollKeys = null;
  }

  /** 一条都不在跑了：把留在页面上的这条冻住 —— 齿轮停转、耗时定在跑完那一刻，字留着
   *  （长命令照旧自己滚：滚是为了看全命令，跟还在不在跑是两回事）。
   *  这一行只有一条，不用挑：几条几乎同时跑完时，页面上的就是最后露着的那条。
   *  已经冻住的再来一遍什么都不动：耗时记的是这条跑了多久，不能跟着后面发生的事继续往上涨。 */
  function freezeRunningLine(st) {
    const line = st.runningLine;
    if (!line) { return; }
    while (line.childElementCount > 1) { line.firstElementChild.remove(); }
    const item = line.lastElementChild;
    if (!item || item.classList.contains("done")) { return; }
    item.classList.add("done");
    stopRunClock(st);
    for (const el of item.querySelectorAll(".tr-time")) {
      if (el._startedAt) { el.textContent = formatElapsed(Date.now() - el._startedAt); }
    }
  }

  /** 把这条整条收掉（连位置一起）。 */
  function dropRunningLine(st) {
    if (!st) { return; }
    stopRunClock(st);
    st.runningKey = "";
    if (st.runningLine) {
      dropRollKeyframes(st.runningLine);
      st.runningLine.remove();
      st.runningLine = null;
    }
  }

  /** 这一批工具过去了（下面出了正文 / 问话卡片，或者这一轮跑完）：把还在留的那条（冻着的那个）
   *  连位置一起收掉。还有工具在跑就不收 —— 那说明这一批还没过去，收掉马上又得开一条，
   *  正是要避免的那种一闪。 */
  function endRunningLine(st) {
    if (!st || !st.paneEl || st._stage === st.paneEl) { return; }
    if (runningCalls(st).length) { return; }
    dropRunningLine(st);
  }

  /** 把这条摆到它该在的地方：这一批的落脚点（那条工具行 / 那块图）下面。 */
  function placeRunningLine(st, line) {
    const tail = st.currentToolTail;
    if (tail && tail.parentElement === st.paneEl) {
      // 当前这批的下面；新一轮工具行上来（上一条正文之后又调了工具）就跟着挪过去。
      // 问话卡片也挂在这一批下面（见 dockAskCardToRow）：这条排在卡片后面，两边不抢位置。
      let after = tail;
      while (after.nextElementSibling && after.nextElementSibling.classList.contains("ask-card")) { after = after.nextElementSibling; }
      if (line.previousElementSibling !== after) { after.after(line); }
      return;
    }
    // 手头没有这一批的落脚点（刚来了一段正文，或者问话卡片把行收掉了）：就待在原地
    // —— 它跟的是它那批，不往新内容下面钻（后一条工具调用开了新行时才挪过去）。
    if (line.parentElement === st.paneEl) { return; }
    // 还没挂上页面（整屏重画之后头一条就是还在跑的调用）：挂在消息流末尾
    const hintRow = st.endHintRow;
    if (hintRow && hintRow.parentElement === st.paneEl) { st.paneEl.insertBefore(line, hintRow); return; }
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
  function endThinking(st, text, forceNew, msg) {
    // 后端现在一字不传（正文只在点开提示框时取），所以“没有文本”不等于“没有这一段”：
    // 只要消息里带着“还有多少字没带过来”，这一段照样要出一颗标签（重放历史全靠这一条）。
    const clip = msg ? clipOf(msg) : null;
    let entry = forceNew ? null : st.thinkingEntry;
    // 收尾（thinking_end）比正文晚到的 provider（openai-completions 那一路：正文边流边给，
    // 收尾整条流跑完才发）会先被“正文开始了”那颗兜底收掉，全文这时才到：补进那一条，
    // 别再新开一颗 —— 不然同一段思考在界面上成了两颗，前一颗还写着空的。
    if (!entry && clip && !forceNew) { entry = pendingThinkOf(st, clip.key); }
    if (!entry) {
      if (!text && !clip) { return; }   // 没在想的、又没有文本（重复收尾）：不用管
      entry = addToolToGroup(st, THINKING_NAME, "", "");
      entry.tipCall = THINKING_NAME;
      noteThinkingEntry(st, entry);
    }
    if (st.thinkingEntry === entry) { st.thinkingEntry = null; }
    if (st.pendingThink === entry) { st.pendingThink = null; }
    entry.done = true;
    if (text) { entry.resultText = text; }
    // 没带全文的收尾（“正文开始了”、这一轮被停掉）不动已经拿到的编号：
    // 后端那边还留着全文，抹掉编号就等于告诉界面“这段没内容可看”。
    if (clip) { entry.clip = clip; }
    // 这一段其实还没收（编号在、全文还没到）：留着等它迟到的收尾，见上面
    if (!clip && entry.clipKey) { st.pendingThink = entry; }
    syncGroupTag(st, entry.group);
    scrollToBottom(st);
  }

  /** 提前收起来、还等着全文的那一颗（见 endThinking）：编号对得上、还长在页面上才认。
   *  编号对不上的是另一段思考，不能拿它的全文往里填。 */
  function pendingThinkOf(st, key) {
    const entry = st.pendingThink;
    st.pendingThink = null;
    if (!entry || !key || entry.clipKey !== key) { return null; }
    const g = entry.group;
    if (!g || g.tag.parentElement !== g.row || g.row.parentElement !== st.paneEl) { return null; }
    return entry;
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

  // ==================== 「只带过来开头」的内容：点开再取 ====================
  // 思考全文与工具输出在界面上默认都收着，后端一个字都不发（见 src/sessionRuntime.ts 的
  // clipDetail），全文留在后端；调用参数只带“一行字那么多”的摘要（摘要那一行要用），整份也留着。
  // 提示框打开时把这一批“没带过来的”一次问回来；这一条还在长（正在想的思考、正在跑的工具）
  // 就每秒再问一次，看得见它往下写。
  const DETAIL_REFRESH_MS = 1000;
  let detailTimer = 0;

  /** 一条消息里“没带全”的记号：{ key: 后端认的编号, omitted: 一共多少字, loaded: 取到全文了 }。
   *  合并组里的每一条挂在 entry.clip 上；不合并的那种单条标签挂在 tag._resultClip 上。 */
  function clipOf(msg) {
    const key = typeof msg.detailKey === "string" ? msg.detailKey : "";
    // 工具输出用 resultOmitted、思考用 omitted（两处发的字段名不一样，这里都认）
    const omitted = typeof msg.resultOmitted === "number" ? msg.resultOmitted
      : (typeof msg.omitted === "number" ? msg.omitted : 0);
    if (!key || !omitted) { return null; }
    return { key: key, omitted: omitted, loaded: false, failed: false };
  }

  /** 提示框里那条小字：还有多少字没带过来 / 取不到了。 */
  function appendClipNote(content, clip) {
    if (!clip || clip.loaded) { return; }
    const note = document.createElement("div");
    note.className = "tag-tip-clip";
    note.textContent = clip.failed
      ? "（这段内容已经取不到了，重新打开这个会话会重新带过来）"
      : "（还有 " + clip.omitted + " 字没带过来，正在取…）";
    content.appendChild(note);
  }

  /** 这一条还有要不要接着问的（没取到全文，或者这一条还在长）。 */
  function clipNeedsMore(tag) {
    const g = tag._tipGroup;
    if (g) {
      return g.entries.some((e) => (e.clip && (!e.clip.loaded || !e.done)) || (e.argsClip && !e.argsClip.loaded));
    }
    return (tag._resultClip && (!tag._resultClip.loaded || tag._done !== true))
      || (!!tag._argsClip && !tag._argsClip.loaded);
  }

  /** 把打开着的这个提示框里没带全的那些一次问回来（一条消息问一把，别一条一个来回）。 */
  function pumpClipDetails(tag) {
    const st = tag._tipGroup ? tag._tipGroup.st : tag._st;
    const sessionId = st ? st.id : "";
    const keys = [];
    const want = (clip, done) => {
      if (!clip || clip.failed) { return; }
      if (clip.loaded && done) { return; }   // 全文到手、这一条也跑完了：不用再问
      keys.push(clip.key);
    };
    const g = tag._tipGroup;
    if (g) {
      for (const e of g.entries) {
        want(e.clip, e.done);
        want(e.argsClip, true);      // 调用参数：要一次就够（它不会再变）
      }
    } else {
      want(tag._resultClip, tag._done === true);
      want(tag._argsClip, true);
    }
    if (keys.length > 0) { vscode.postMessage({ type: "loadDetails", sessionId: sessionId, keys: keys }); }
  }

  function stopClipPump() {
    if (detailTimer) { clearInterval(detailTimer); detailTimer = 0; }
  }

  function startClipPump(tag) {
    stopClipPump();
    pumpClipDetails(tag);
    if (!clipNeedsMore(tag)) { return; }
    detailTimer = setInterval(() => {
      if (tagTipTag !== tag) { stopClipPump(); return; }
      pumpClipDetails(tag);
      if (!clipNeedsMore(tag)) { stopClipPump(); }
    }, DETAIL_REFRESH_MS);
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
    stopClipPump();
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
    appendClipNote(tagTipContent, tag._resultClip);
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
      startClipPump(tag);    // 没带全的那些（思考全文 / 工具输出）这就去要
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
   *  截断部分不支持点击展开（卡片内展开体验差且容易误触），改用右上角“跳转”按钮打开完整文件。
   *  clipped：后端只带了参数开头（见 sessionRuntime 的 clipArgs）——这时候“共 N 行”是按
   *  带过来的那段算的，不准，所以改说一句“只带了开头”。 */
  function buildWritePreviewEl(argStr, clipped) {
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
    if (clipped) {
      const hint = document.createElement("div");
      hint.className = "tc-trunc-hint";
      hint.textContent = "... (内容只带了开头)";
      hint.title = "点击右上角“跳转”按钮查看完整文件";
      wrap.appendChild(hint);
    } else if (total > MAX_LINES) {
      const hint = document.createElement("div");
      hint.className = "tc-trunc-hint";
      hint.textContent = "... (" + (total - MAX_LINES) + " 行未显示,共 " + total + " 行)";
      hint.title = "点击右上角“跳转”按钮查看完整文件";
      wrap.appendChild(hint);
    }
    return wrap;
  }

  // ==================== 工具结果内联图片（read 读图等） ====================
  /**
   * Lightbox：点击缩略图全屏查看原图。
   *
   *   - 滚轮缩放（1 到 6 倍），以鼠标所指那一点为定点 —— 边滚边看某一处细节时，那处不会跑掉；
   *   - 手机上两指捏合缩放，定点是两指中点；两指一起挪就是平移；
   *   - 放大后按住拖动看别处（鼠标、手指都走 pointer 这一套）；
   *   - 双击回到刚打开的样子；
   *   - Esc 或点图外的黑底关掉；没放大时点图本身也关（老习惯），放大后点图不关，那是留给拖动的。
   *
   * 缩放与平移只记三个数（scale、x、y，原点在图中心），实际落到图片上是 translate + scale。
   */
  const LIGHTBOX_MAX_SCALE = 6;
  let lightboxEl = null;
  const lightboxView = { scale: 1, x: 0, y: 0, drag: false, px: 0, py: 0, ox: 0, oy: 0, guardUntil: 0 };
  /** 现在按在图上的是哪些指针：双指缩放要两根的距离，单指拖动只要一根。 */
  const lightboxPointers = new Map();
  const lightboxPinch = { on: false, dist: 1, scale: 1, mx: 0, my: 0 };

  function lightboxPaint() {
    if (!lightboxEl) { return; }
    const v = lightboxView;
    lightboxEl.firstChild.style.transform = v.scale === 1
      ? ""
      : "translate(" + v.x + "px, " + v.y + "px) scale(" + v.scale + ")";
    lightboxEl.classList.toggle("zoomed", v.scale > 1);
  }

  function lightboxReset() {
    const v = lightboxView;
    v.scale = 1; v.x = 0; v.y = 0;
    lightboxPaint();
  }

  function closeLightbox() {
    if (!lightboxEl) { return; }
    lightboxEl.classList.add("hidden");
    lightboxEl.firstChild.removeAttribute("src");   // 别再抱着那张图（可能是几 MB 的 data:）
    lightboxPointers.clear();
    lightboxPinch.on = false;
    lightboxView.drag = false;
    lightboxEl.classList.remove("dragging");
    lightboxReset();
  }

  /** 把图缩放到 next 倍，屏幕上 (clientX, clientY) 那一点底下的图不动。 */
  function lightboxZoomTo(clientX, clientY, next) {
    const v = lightboxView;
    next = Math.min(LIGHTBOX_MAX_SCALE, Math.max(1, next));
    if (next === v.scale) { return; }
    if (v.scale === 1) { v.x = 0; v.y = 0; }
    const r = lightboxEl.getBoundingClientRect();
    const cx = clientX - (r.left + r.width / 2);   // 这一点相对图中心偏出去多少
    const cy = clientY - (r.top + r.height / 2);
    const k = next / v.scale;
    v.x = cx - k * (cx - v.x);
    v.y = cy - k * (cy - v.y);
    v.scale = next;
    if (v.scale === 1) { v.x = 0; v.y = 0; }         // 缩回原样：平移一并清掉，图重新居中
    lightboxPaint();
  }

  /** 按着的那两根指：间距与中点（双指缩放全靠这两个数）。 */
  function lightboxPinchState() {
    const pts = Array.from(lightboxPointers.values());
    const a = pts[0] || { x: 0, y: 0 };
    const b = pts[1] || a;
    return {
      dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }

  function openLightbox(src) {
    if (!lightboxEl) {
      lightboxEl = document.createElement("div");
      lightboxEl.className = "lightbox hidden";
      lightboxEl.appendChild(document.createElement("img"));
      const img = lightboxEl.firstChild;
      lightboxEl.addEventListener("click", (e) => {
        // 刚捏完 / 刚拖完松手那一下不算点击（不然一松手图就没了）
        if (performance.now() < lightboxView.guardUntil) { return; }
        if (e.target === lightboxEl || lightboxView.scale === 1) { closeLightbox(); }
      });
      img.addEventListener("dblclick", (e) => { e.preventDefault(); lightboxReset(); });
      img.addEventListener("wheel", (e) => {
        e.preventDefault();
        lightboxZoomTo(e.clientX, e.clientY, lightboxView.scale * Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });
      img.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) { return; }
        lightboxPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { img.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败也还能拖 */ }
        if (lightboxPointers.size === 2) {
          // 第二根手指落下：改双指缩放，正在拖的那一根就此停住
          lightboxView.drag = false;
          lightboxEl.classList.remove("dragging");
          const p = lightboxPinchState();
          lightboxPinch.on = true;
          lightboxPinch.dist = p.dist;
          lightboxPinch.scale = lightboxView.scale;
          lightboxPinch.mx = p.mx; lightboxPinch.my = p.my;
          return;
        }
        if (lightboxPointers.size > 2) { return; }
        if (lightboxView.scale === 1) { return; }
        lightboxView.drag = true;
        lightboxView.px = e.clientX; lightboxView.py = e.clientY;
        lightboxView.ox = lightboxView.x; lightboxView.oy = lightboxView.y;
        lightboxEl.classList.add("dragging");
      });
      img.addEventListener("pointermove", (e) => {
        const held = lightboxPointers.get(e.pointerId);
        if (held) { held.x = e.clientX; held.y = e.clientY; }
        const v = lightboxView;
        if (lightboxPinch.on && lightboxPointers.size >= 2) {
          // 两指间距变大就放大；两指一起挪（中点动了）就跟着平移
          const p = lightboxPinchState();
          lightboxZoomTo(p.mx, p.my, lightboxPinch.scale * (p.dist / lightboxPinch.dist));
          if (v.scale > 1) {
            v.x += p.mx - lightboxPinch.mx;
            v.y += p.my - lightboxPinch.my;
            lightboxPaint();
          }
          lightboxPinch.mx = p.mx; lightboxPinch.my = p.my;
          return;
        }
        if (!v.drag) { return; }
        v.x = v.ox + (e.clientX - v.px);
        v.y = v.oy + (e.clientY - v.py);
        lightboxPaint();
      });
      const endPointer = (e) => {
        const wasPinch = lightboxPinch.on;
        lightboxPointers.delete(e.pointerId);
        if (lightboxPointers.size < 2) { lightboxPinch.on = false; }
        // 捏合 / 拖着松手之后紧跟的那一下 click 不算点击
        if (wasPinch || lightboxView.drag) { lightboxView.guardUntil = performance.now() + 400; }
        const v = lightboxView;
        v.drag = false;
        lightboxEl.classList.remove("dragging");
        if (lightboxPointers.size === 1 && v.scale > 1) {
          // 还剩一根手指：接着拖，从它现在的位置算起（不然图会跳一下）
          const p = Array.from(lightboxPointers.values())[0];
          v.drag = true;
          v.px = p.x; v.py = p.y;
          v.ox = v.x; v.oy = v.y;
          lightboxEl.classList.add("dragging");
        }
      };
      img.addEventListener("pointerup", endPointer);
      img.addEventListener("pointercancel", endPointer);
      document.body.appendChild(lightboxEl);
    }
    lightboxPointers.clear();
    lightboxPinch.on = false;
    lightboxView.drag = false;
    lightboxEl.classList.remove("dragging");
    lightboxReset();
    lightboxEl.firstChild.src = src;
    lightboxEl.classList.remove("hidden");
  }

  // Esc 关这一层。放在捕获阶段、并且就地吃掉这条按键：document 上后面那个「Esc 中止这一轮」
  // 也是听同一个键，不拦下来就会顺手把正在生成的这轮也停了（跟「项目与会话」那层一个道理）。
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !lightboxEl || lightboxEl.classList.contains("hidden")) { return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    closeLightbox();
  }, true);

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
    el.title = "点开放大看（滚轮缩放、双击还原）";
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
   * 块自己占一行（不跟正文挤在同一行里）。位置就摆在**这条调用所在那一排工具行**上：消息流是
   * 一条条往下接的，图是这条调用的结果，就该排在它当时那个地方 —— 扔到消息流末尾的话，后面
   * 已经接上的正文 / 调用都会被它挤到上面去（顺序就乱了）。插完这一批就算断了：后面的调用另起
   * 一行排在图下面（见 toolTagHost），不然它们会回到上面那排里、排到图上面去。
   * 那条工具行空了要收掉（见 dropToolRow）：调用方先把这一排记下来（at.row），插好图再收，
   * 顺序反了就找不着地方。调用方传 at：{ toolName, argStr, tipCall, toolCallId, row }
   * （toolCallId 用来认“首屏没带过来的那张图”，见 resultImageChip）。
   */
  function mountToolImageBlock(st, at, images) {
    if (!Array.isArray(images) || images.length === 0) { return; }
    const call = at || {};
    const key = call.toolCallId && !isStageRender(st) ? "img:" + call.toolCallId : "";
    let known = key ? st.byId.get(key) : null;
    if (known && known.dataset.midKind !== "image") { st.byId.delete(key); known = null; }
    if (known) {
      // 重放时同一张图又来了：那块图原样留着（图不用重新解码），挪到该在的位置就行
      placeUnit(st, known);
      if (st.reconcile) { st.currentToolTail = known; }
      scrollToBottom(st);
      return;
    }
    const block = document.createElement("div");
    block.className = "tool-image-block" + enterCls(st);
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
    if (key) { block.dataset.mid = key; block.dataset.midKind = "image"; st.byId.set(key, block); }
    if (st.reconcile) {
      // 重放中：旧的那条工具行这会儿正要被收掉，插到游标处就行
      placeUnit(st, block);
      st.currentToolTail = block;
      scrollToBottom(st);
      return;
    }
    const row = call.row && call.row.parentElement === st.paneEl ? call.row : null;
    if (row) {
      st.paneEl.insertBefore(block, row.nextSibling);
      // 这一批的落脚点换成这块图：后面的调用另起一行、排在图下面（见 toolTagHost）。“是这一批吗”
      // 看它插的这排还是不是当前这一批：图回来得晚（后面又出了正文 / 又调了工具）就只插图、
      // 不动当前这一批。
      if (row === st.currentToolTail) {
        st.currentToolTail = block;
        // 「正在跑的那一条」认这块图（这一批还没过去，它还得留在这块图下面）
        if (st.runningLine) { placeRunningLine(st, st.runningLine); }
      }
    } else {
      // 那一排已经不在了（整屏重画过 / 从来没给过 row）：只能挂在消息流末尾
      st.paneEl.appendChild(block);
    }
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
  function buildEditCard(st, toolName, label, filePath, toolCallId, argStr, argsClipped) {
    hideEmptyHint(st);
    let pendingResult = null;   // 结果（含 diff）：提示框随取随画
    let resultDone = false;
    let reverted = false;
    // 参数一开始可能一点没带过来（后端只留了“一共多少字”），点开提示框时再取：
    // 取回来换到这里，写入预览才画得出来（见 detail 那条消息）
    let argsJson = argStr;
    let argsTruncated = !!argsClipped;

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
            const pv = buildWritePreviewEl(argsJson, argsTruncated);
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

    // 参数取回来了：换掉那一份，并把“只带了开头”改成实话
    entry.applyArgs = (json) => {
      argsJson = json;
      argsTruncated = false;
    };

    return {
      // 统计那边要用：这一条是哪个工具、在提示框里那一行写的是什么（见 noteToolDuration）
      toolName,
      entry,
      callText: toolName + " " + (label || filePath || ""),
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

  // ==================== 自动模式那颗按钮（输入框右下角最右边）====================
  // 长成一颗小开关（圆角胶囊里一颗滑块）：滑块在左、灰着 = 没开，拨到右、变绿 = 开着。
  // 点一下就是拨一下：开的时候再点就是停。
  // 指上去写着现在第几轮、判官是不是正在看，字都由后端拼好（见 auto.ts 的 autoIndicatorTitle）。
  let autoBtn = null;
  (function buildAutoButton() {
    const row = document.getElementById("inputRow");
    if (!row) { return; }
    autoBtn = document.createElement("button");
    autoBtn.type = "button";
    autoBtn.id = "autoBtn";
    // 小开关：胶囊 + 滑块，样子全在 chat.css 里（#autoBtn .autoPill）
    autoBtn.innerHTML = '<span class="autoPill" aria-hidden="true"></span>';
    autoBtn.title = "自动模式（点一下开始）";
    autoBtn.setAttribute("aria-label", "自动模式");
    // 摆在框底那条横排的最右头（前头依次是加号、模型胶囊、「你说过的话」）
    row.appendChild(autoBtn);
    autoBtn.addEventListener("click", () => {
      const st = activeSession();
      if (!st) { return; }
      // 开着就停，没开就开始（那颗按钮上看着是什么就做什么）
      vscode.postMessage({ type: "autoAct", sessionId: st.id, act: st.auto ? "stop" : "start" });
    });
  })();

  function renderAutoIndicator() {
    if (!autoBtn) { return; }
    const st = activeSession();
    const auto = st ? st.auto : null;
    const title = auto ? ((st && st.autoTitle) || "自动模式（点一下停止）") : "自动模式（点一下开始）";
    autoBtn.title = title;
    autoBtn.setAttribute("aria-label", title);
    autoBtn.classList.toggle("on", !!auto);
    // 开着的时候输入框外面那圈有流光（见 chat.css 的 #composer.auto）：不用盯着那颗小开关也知道它在自己跑
    const composer = document.getElementById("composer");
    if (composer) { composer.classList.toggle("auto", !!auto); }
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
    const st = activeSession();
    // 一个会话都没有时那颗「+」不给点：新会话总得开在某个工作区里，先在「项目与会话」里挑一个
    if (newSessionBtn) { newSessionBtn.disabled = !st; }
    syncNoSessionHint();
    syncEndHint(st);
  }

  /**
   * 一个会话都没有（刚打开页面、或者刚把最后几个关掉）时，消息流中间摆一块提示：
   * 告诉人去「项目与会话」里挑一个工作区开新会话、或者点开一条历史会话。
   * 这会儿右边那一列已经替人摊开了（见 openWorkspaceForEmpty），只是得有一句话说明白要干什么
   * ——以前这儿是一片白的，看着像界面没起来。
   */
  function syncNoSessionHint() {
    if (!noSessionHintEl) { return; }
    // 看的是“一个会话都没有”，不是“这一瞬没在看哪一个”：切会话、刚新建还没挂上的那一阵
    // 会话壳已经在 sessions 里了，别闪一下提示
    noSessionHintEl.classList.toggle("hidden", sessions.size > 0);
  }

  /** 消息流末尾那颗胶囊上写的是什么。 */
  const END_HINT_CONTINUE = "继续";
  const END_HINT_STUCK = "卡住了";
  /** 末尾那两颗快捷按钮点下去发出去的文本（见 makeEndHintQuick）：
   *  - 「压缩」发 /compact，插件自己接手去调 pi 的压缩命令；
   *  - 「啊？」发 bro 技能的正文：让 ai 用大白话把上一条重说一遍。正文照技能文件抄在代码里，
   *    不去读磁盘上的 SKILL.md（网页端读不到，也不该为这一句多开一条读文件的路）。 */
  const QUICK_COMPACT_TEXT = "/compact";
  const QUICK_BRO_TEXT = "Restate your last message. Stop using jargon and speak coherently." +
    " State it more simply and concisely, like one human talking to another.";

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
    // “有没有可接着往下走的对话”只看用户与助手两种消息：会话里那些系统消息
    //（正在压缩、已回滚那一类）不能算 —— 空会话里摆一颗“继续”没意义。
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
    // 跑完时多出来的两颗快捷按钮（「压缩」「啊？」）：跟「继续」一起露面、一起收
    for (const q of row.querySelectorAll(".msg-endhint-quick")) {
      q.classList.toggle("hidden", mode !== "continue");
    }
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
   * 建末尾那一行：主胶囊（继续 / 卡住了）、旁边那颗「停止生成」，以及闲着时才会露出来的
   * 两颗快捷按钮「压缩」「啊？」。
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
    // 不给 id：每个会话都有一颗，同一个 id 会在页面上重复（getElementById 会摸到别的会话那颗）
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
    // 跑完之后顺手点一下的两颗（见 makeEndHintQuick）：摆在主胶囊左边，淡一点
    const compactBtn = makeEndHintQuick(st,
      "压缩", "压缩上下文（发一条 /compact）", QUICK_COMPACT_TEXT);
    const broBtn = makeEndHintQuick(st,
      "啊？", "让 ai 用大白话把上一条重说一遍（bro 技能）", QUICK_BRO_TEXT);
    // 顺序：压缩、?、停止生成（方块）、主胶囊（继续 / 卡住了）
    row.append(compactBtn, broBtn, stop, btn);
    st.endHintEl = btn;
    st.endHintStopEl = stop;
    return row;
  }

  /**
   * 末尾那一行上的快捷按钮：点一下直接发一条固定的话，不碰输入框里打了一半的字。
   * 只在会话闲着（「继续」露面）时出现，见 syncEndHint。
   */
  function makeEndHintQuick(st, label, title, text) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-endhint msg-endhint-quick";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.textContent = label;
    b.addEventListener("click", () => {
      const cur = activeSession();
      if (!cur || cur.id !== st.id || !cur.piReady) { return; }
      if (cur.loading || cur.streaming) { return; }
      // 先收起来：手快连点两下会发两条出去（等后端的消息回显再按真实状态算）
      b.classList.add("hidden");
      vscode.postMessage({ type: "send", sessionId: cur.id, text, images: [] });
      if (!IS_TOUCH_DEVICE) { inputEl.focus(); }
      // 万一点击没送到（连接断了），过一会儿按真实状态重新算
      setTimeout(() => syncEndHint(cur), 1500);
    });
    return b;
  }

  function updateSendState() {
    // VSCode 里发送/中止只看键盘（Enter 发送、Esc 中止），没有按钮；状态文案由 syncStatus 负责。
    // 网页端（尤其手机）没有 Esc：消息流末尾那一行闲着是「继续」、生成中是「卡住了」加一颗
    // 只有方块的「停止生成」（见 syncEndHint）。
    syncComposerButtons();
  }
  // 完整名字（provider/模型/思考档）：只给悬浮提示用。
  function modelFullFor(st) {
    const id = (st && st.modelId) || "";
    if (!id) { return ""; }
    const prov = (st && st.provider) || "";
    return (prov ? prov + "/" : "") + id + (st.thinkingLevel ? "/" + st.thinkingLevel : "");
  }
  // ==================== 生成速度（t/s） ====================
  // 算在后端（见 src/sessionRuntime.ts 的 noteGenTokens）：思考、正文、工具参数都算 token，
  // 时间只算模型真在吐字的那段；250ms 推一次，停下了推最后那个数（见 case "tps"）。
  // 界面这边只管把数写出来（见 syncStatus），数存在 st.tps 上。
  // ==================== 输入框底下那颗胶囊：模型名 + 上下文用量 + 生成速度 ====================
  // 原来每个会话底部占一整行状态栏，后来收成顶条左边一颗圆环，现在搬进输入框底下那条
  // 小横排里、跟模型名合成一颗胶囊（见 renderHtml 的 #composer / #ctxIcon）：
  // 左边是模型名，中间一条小横条（上头写百分比、下头那条杠填到哪儿就是用了多少，
  // ≥70% 黄、≥90% 红），右边是这一轮的生成速度（t/s）；
  // 模型全名、精确百分比也放悬浮提示里；点它切当前会话的模型。
  // 它说的是当前会话（一次只看一个）：切会话、模型变了、用量变了、速度涨了都调 syncStatus 重刷。
  // 还没就绪的几种状态另挂在 data-st 上（loading / wait / nomodel / idle / streaming），
  // dev/ 那套调试工具靠它判断“可以发消息了”与“这轮跑完没”。
  function ctxPercent(st) {
    if (!st || typeof st.percent !== "number") { return 0; }
    return Math.max(0, Math.min(100, st.percent));
  }
  function ctxState(st) {
    // 一个会话都没有（刚打开页面，还等着在「项目与会话」里挑一个）：胶囊里只写“没有会话”
    if (!st) { return "none"; }
    if (st.loading) { return "loading"; }
    if (!st.piReady) { return "wait"; }
    if (!st.modelId) { return "nomodel"; }
    return st.streaming ? "streaming" : "idle";
  }
  function ctxTitle(st) {
    if (!st) { return "还没有会话（在右边的「项目与会话」里挑一个工作区开始）"; }
    const state = ctxState(st);
    if (state === "loading") { return "加载中…"; }
    if (state === "wait") { return "等待 pi 启动…"; }
    if (state === "nomodel") { return "未配置模型（点击选择）"; }
    const parts = [modelFullFor(st)];
    if (typeof st.percent === "number") { parts.push("上下文 " + st.percent.toFixed(1) + "%"); }
    if (typeof st.tps === "number") { parts.push(st.tps.toFixed(1) + " t/s"); }
    return parts.join(" · ") + "\n点击切换模型";
  }
  /**
   * 胶囊里那个模型名（横条左边）。只写模型 id，全名 / 思考档在悬浮提示里（见 modelFullFor）。
   * 还没就绪的几种状态写一句短的：不然胶囊里只剩一条空横条，点了也不知道会发生什么。
   */
  function ctxName(st, state) {
    if (state === "none") { return "没有会话"; }
    if (state === "loading") { return "加载中"; }
    if (state === "wait") { return "启动中"; }
    if (state === "nomodel") { return "选模型"; }
    return (st && st.modelId) || "";
  }
  /** 模型名左边那颗状态动画至少显示这么久才准换（见 syncStatus）。 */
  const ACT_MIN_MS = 300;

  // 同一颗胶囊上「+N」最快隔这么久才飘一次：一轮里用量会碎步刷新好几次，太密就看不清了
  const CTX_PLUS_GAP_MS = 500;
  /** 正在飘着的那颗「+N」，以及它出生时条上头那个数字（整数百分比）和当时看着的会话。 */
  let ctxPlusEl = null;
  let ctxPlusNum = null;
  let ctxPlusSession = "";

  /** 用量涨了：百分比数字上方飘一个「+N」。
   *  动效用的是工具标签次数方块上那个（chat.css 的 .ci-plus 与 tg-plus-float）。
   *  锚在 .ci-top（position: relative）里，不占位置、不挡鼠标。
   *  传进来的是条上头那个数字（整数百分比，见 syncStatus）：只有它真变了才飘，
   *  飘的量就是它变了几点（涨 1 点飘 +1，一下涨 4 点飘 +4）。
   *  用量掉了（压缩上下文）不飘。同一颗胶囊有间隔限制，刷得再密也半秒最多一回。 */
  function popCtxPlus(st, pct) {
    const from = st ? st.pctPopFrom : undefined;
    if (st) { st.pctPopFrom = pct; }
    if (!st || typeof from !== "number" || pct <= from) { return; }
    const topEl = ctxIconEl.querySelector(".ci-top");
    if (!topEl) { return; }
    const now = Date.now();
    if (now - (st.plusAt || 0) < CTX_PLUS_GAP_MS) { return; }
    st.plusAt = now;
    if (ctxPlusEl) { ctxPlusEl.remove(); }   // 上一个还在飘：换成新的，重新从底下再飘一遍
    const pop = document.createElement("span");
    pop.className = "ci-plus";
    pop.textContent = "+" + Math.max(1, Math.round(pct - from));
    topEl.appendChild(pop);
    ctxPlusEl = pop;
    ctxPlusNum = pct;
    ctxPlusSession = activeId;
    setTimeout(() => { pop.remove(); if (ctxPlusEl === pop) { ctxPlusEl = null; } }, 900);
  }

  /** 飘着的「+N」只跟它出生时那个数字、那个会话算数：数字一变（涨、退回去、换会话后不一样）
   *  就立刻收掉。不这么做就会出现“数字看着没动，却有颗 +1 在飘”——
   *  比如用量先粗估到 2%（飘了 +1）、几十毫秒后换成实际的 1.4%，数字退回去了，
   *  那颗 +1 还在飞的那半秒里就成了假象。 */
  function dropCtxPlusIfStale(num) {
    if (!ctxPlusEl) { return; }
    if (ctxPlusSession === activeId && ctxPlusNum === num) { return; }
    ctxPlusEl.remove();
    ctxPlusEl = null;
  }

  /** 输入框底下那颗胶囊跟上当前会话。 */
  function syncStatus() {
    if (!ctxIconEl) { return; }
    const st = activeSession();
    const pct = ctxPercent(st);
    const state = ctxState(st);
    ctxIconEl.dataset.st = state;
    // 跑着的时候再细一层，挂到 data-act 上（界面按它换形象与动法，见 chat.css 那几条）：
    //   thinking 后端说在想；tool 后端说工具在跑；
    //   剩下那种后端只说 working 的，界面再分两面：正文正在流（写）与还没吐字（等）。
    //   “正文在流”看 st.currentAssistant：它在第一条正文增量时建、这段吐完就清（见 assistantDelta /
    //   finalizeCurrentAssistant），所以正好就是“笔在写”的那段时间。
    const act = st ? st.activity : "";
    const writing = !!(st && st.currentAssistant);
    const wantAct = state !== "streaming" ? ""
        : act === "thinking" ? "thinking"
            : act === "tool" ? "tool"
                : writing ? "writing" : "waiting";
    // 状态至少显示这么久才准换：正文吐完那一下会冒出“等”，几十毫秒后又变成工具；
    // 不挡一下就看着抖。等不到那一下的（本来就是空、或者这一轮停了）立即生效。
    let shown = st ? st.actShown || "" : "";
    if (!st) { shown = ""; } else if (wantAct !== shown) {
        const left = ACT_MIN_MS - (Date.now() - (st.actShownAt || 0));
        // 这一轮停了（wantAct 空了）就立即收：那时候 data-st 已经是 idle，图标本来就不显，
        // 但别把旧状态留在 data-act 上（调试工具、下一次进来都会看到它）
        if (left > 0 && shown && wantAct) {
            // 还没到能换的时候：先照旧的挂着，到点了再按当时的最新状态重算一次
            if (!st.actTimer) {
                st.actTimer = setTimeout(() => {
                    st.actTimer = 0;
                    if (activeId === st.id) { syncStatus(); }
                }, left);
            }
        } else {
            shown = wantAct;
            st.actShown = wantAct;
            st.actShownAt = Date.now();
        }
    }
    ctxIconEl.dataset.act = shown;
    ctxIconEl.classList.toggle("warn", pct >= 70 && pct < 90);
    ctxIconEl.classList.toggle("err", pct >= 90);
    ctxIconEl.title = ctxTitle(st);
    const name = ctxIconEl.querySelector(".ci-name");
    if (name) { name.textContent = ctxName(st, state); }
    // 横条：填多满就是用了多少（一个数写进 --ci-pct，横条宽度认它，见 chat.css）；
    // 条上头那行字写整数百分比（横条这儿放得下，就带个 %，不看形状也认得出来）。
    // 还没量出来（没配模型 / 还没报过用量）就空着。
    const known = (state === "idle" || state === "streaming") && typeof st.percent === "number";
    ctxIconEl.style.setProperty("--ci-pct", known ? pct.toFixed(1) + "%" : "0%");
    ctxIconEl.classList.toggle("hasfill", known && pct > 0);
    // 用量涨了：数字上方飘一个「+N」（跟工具标签次数方块上那个「+1」同一套动效）。
    // 比的是条上头那个数字（整数百分比），不是原始值：不然会出现“飘了但数字没动”
    // —— 原始值涨 0.3% 数字还是 1%，看着就像坏了。数字变了才飘，飘的就是它变了多少。
    const shownNum = known ? Math.round(pct) : null;
    dropCtxPlusIfStale(shownNum);
    if (known) { popCtxPlus(st, shownNum); } else if (st) { st.pctPopFrom = undefined; }
    const num = ctxIconEl.querySelector(".ci-text");
    if (num) { num.textContent = known ? Math.round(pct) + "%" : ""; }
    // 跑多快：后端推来的那个数（生成中是这一轮的实时均值，停下来就留着最后那个，没跑过就空着）
    const speed = ctxIconEl.querySelector(".ci-tps");
    if (speed) {
      const tps = st ? st.tps : undefined;
      speed.textContent = typeof tps === "number" ? tps.toFixed(1) + " t/s" : "";
    }
  }

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
    renderAutoIndicator();
    syncJumpBottom(st);
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
    // 切走也算看过了：刚看完的那个会话的绿点收掉（绿点只说“这一轮刚跑完，等你回来”）
    const leaving = activeId !== null ? sessions.get(activeId) : null;
    if (leaving && leaving.turnDone) { leaving.turnDone = false; }
    activeId = id;
    // 左边那一列看的是会话目录里的文件：换了会话就收成一句提示
    resetFileSidebarForSession();
    // 看过了：那颗“这一轮跑完了”的小绿点收掉
    const shown = sessions.get(id);
    if (shown && shown.turnDone) { shown.turnDone = false; }
    mountActiveSession();
    closeSaidMenu();   // 清单里排的是上一个会话说过的话：换了会话就收起来
    restoreInputState();
    reflectSessionUI();
    renderSessionBar();
    refreshOpenSessionsInPicker();
    // 「工具」那张清单是一个会话一份：弹窗开着换了会话，就换成新会话那一份
    if (envOpen()) { requestEnv(); }
    if (!IS_TOUCH_DEVICE) { inputEl.focus(); }
    // 切到这个会话：排在"还没有会话"名下的消息现在有主了，能发就发
    flushPendingSend();
    // 刚切走那个（以及别的）闲下来后先排好版，下次切过去不用现排
    scheduleKeep();
  }

  /**
   * 切到某个会话：本机先切，不等后端回话。
   *
   * 后端那一圈（发请求 → 它记下“这块屏看的是哪个” → 回一句 sessionActivated）在手机上是一个
   * 来回，几百毫秒到一两秒；以前界面就干等着，按下去之后一直是旧画面。现在按下就把那屏挂出来、
   * 顶条挪过去，请求照发：它回来时 activateSessionView 一看“已经是我了”，直接跳过。
   */
  function requestSwitch(sessionId) {
    if (!sessionId) { return; }
    const st = sessions.get(sessionId);
    // 壳已经在、也没在加载：先切过去。没壳（没到 / 以前关掉的）就先发请求，等后端把列表推回来
    if (st && !st.loading && sessionId !== activeId) { activateSessionView(sessionId); }
    vscode.postMessage({ type: "switchSession", sessionId: sessionId });
  }

  /** 这份会话文件是不是有会话正开着（列表里把这种历史行标成“已打开”）。 */
  function sessionOpenForFile(file) {
    if (!file) { return false; }
    const norm = pathCaseKey;
    const want = norm(file);
    for (const st of sessions.values()) {
      if (st.sessionFile && norm(st.sessionFile) === want) { return true; }
    }
    return false;
  }

  /**
   * 「正在对话」这些行列首那颗小点的样式名（顶条下拉框与面板共用同一套）：
   * 在跑＝蓝点呼吸，出错＝红点，跑完了＝绿点不闪（主会话、子会话都是），其余不显示。
   */
  function openDotClass(item) {
    if (item.streaming || item.loading) { return " running"; }
    if (item.taba && item.taba.state === "error") { return " error"; }
    if (item.turnDone || (item.taba && item.taba.state === "waiting")) { return " done"; }
    return "";
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
        turnDone: !!st.turnDone,
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
   * 按快捷键 / 手机上左右划切会话时，下一个（或上一个）是哪一个：走的就是「项目与会话」面板里
   * 「正在对话」那一段的行序（主会话在前，它派出去的子会话缩进跟在它下面，一行算一个）。
   * 当前看的会话不在那几行里（它已经被别的窗口关掉、画面还留在这屏）时：
   * 下一个从第一行起，上一个从末行起。只有一个会话就没有下一个（返回 null）。
   */
  function sessionIdByDirection(direction) {
    const ids = openSessionItems().map((item) => item.sessionId);
    if (ids.length < 2) { return null; }
    const curIdx = ids.indexOf(activeId);
    const from = curIdx < 0 ? (direction === "next" ? -1 : 0) : curIdx;
    const delta = direction === "next" ? 1 : -1;
    return ids[(from + delta + ids.length) % ids.length] || null;
  }

  /** 按快捷键切上一个 / 下一个会话（顺序见 sessionIdByDirection）。 */
  function switchSessionByDirection(direction) {
    const target = sessionIdByDirection(direction);
    if (target) { requestSwitch(target); }
  }

  // ==================== 手机上左右划：切上一个 / 下一个会话 ====================
  // 只认手指 / 触控笔的横划（鼠标拖拽不算：电脑上有快捷键）。横着划过一小段就跟手走：
  // 正在看的那个壳跟着手指挪，下一个从另一边进来；松手过了线就滑到底、真的切过去，
  // 没过线就弹回去。竖着划不管（那是滚动），横着能滚的东西（代码块、表格）上也不管。
  // 切过去那一刻位置由后端说了算：松手先跟后端要，它回话说“切到这个了”时再从手指离开的
  // 位置滑完那一小段（见 mountActiveSession 开头那段）。
  const SWIPE_LOCK_PX = 6;       // 横向动这么多就认成“左右划”（快划时那段“没反应”就是它，越小越跟手）
  const SWIPE_CANCEL_PX = 10;    // 竖着动这么多、而且比横向多：这是滚动，这一趟不管了
  const SWIPE_FINISH_MS = 180;   // 松手后滑完的那一小段
  const SWIPE_WAIT_MS = 1500;    // 松手后等后端回话的耐心（回话迟了就先弹回去）

  function swipeWidth() { return messagesEl.clientWidth || window.innerWidth || 320; }

  /** 横着能滚的东西上不切会话：让人家自己滚（代码块、表格、长清单）。 */
  function swipeStartsInScrollable(el) {
    for (let n = el; n && n !== messagesEl; n = n.parentElement) {
      if (n.scrollWidth - n.clientWidth > 4) { return true; }
    }
    return false;
  }

  /** 跟着手指走的那点位移：过了半屏就加阻力（再划也不跟得那么死，手底有点手感）。 */
  function swipeOffset(dx, width) {
    const cap = width * 0.5;
    const a = Math.abs(dx);
    if (a <= cap) { return dx; }
    return (dx < 0 ? -1 : 1) * (cap + (a - cap) * 0.25);
  }

  /** 一节样式里的位移一改就要滑一小段：给它挂上过渡。 */
  function slideTo(el, x, ms) {
    el.style.transition = ms ? "transform " + ms + "ms ease-out" : "none";
    el.style.transform = "translateX(" + x + "px)";
  }

  /** 摆出来的样子收回原样（位移、过渡都清掉）。 */
  function clearSlideStyles(el) {
    el.style.transform = "";
    el.style.transition = "";
  }

  /** 等这一下过渡走完（或等超时兜底）再办收尾的事，只办一次。 */
  function afterSlide(el, fn) {
    let done = false;
    const once = () => {
      if (done) { return; }
      done = true;
      el.removeEventListener("transitionend", onEnd);
      fn();
    };
    const onEnd = (e) => { if (e.target === el && e.propertyName === "transform") { once(); } };
    el.addEventListener("transitionend", onEnd);
    setTimeout(once, SWIPE_FINISH_MS + 120);
  }

  /** 认成横划以后：把要进来的那个壳从另一边摆出来（它本来藏着，这会儿得画出来）。 */
  function swipeBegin(s) {
    const to = s.toView;
    unkeep(s.to);
    to.classList.remove("off");
    if (to.parentElement !== messagesEl) { messagesEl.appendChild(to); }
    s.fromView.style.transition = "none";
    to.style.transition = "none";
    // 两个壳这会儿是一左一右摆着的：越出去的那点别把整页撑出横向滚动条
    messagesEl.classList.add("swiping");
    // 鼠标从空白处拖进文字里，浏览器会顺势选上一段：抹掉（真在选字的那种根本走不到这儿）。
    // 只有鼠标要抹：手指不会这么选出东西来，而这一问（getSelection）会逼浏览器把整个文档
    // 的样式与排版现算一遍（几千轮的会话里量到过几十毫秒，见 dev/swipePerf.js）。
    if (s.finger === "mouse") { dropSelection(); }
  }

  /** 把浏览器顺手弄出来的选择抹掉（没有选择就什么也不做）。 */
  function dropSelection() {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) { sel.removeAllRanges(); }
    } catch (e) { /* 拿不到就算了 */ }
  }

  /** 跟着手指摆：正在看的那个挪 eff，进来的那个紧贴在它旁边（隔一个整屏）。 */
  function swipePlace(s) {
    const w = s.width;
    slideTo(s.fromView, s.eff, 0);
    slideTo(s.toView, s.dir === "next" ? s.eff + w : s.eff - w, 0);
  }

  /** 松手：够远了（或者甩得快）就真切过去，不够就弹回原位。 */
  function swipePast(s) {
    const dist = Math.abs(s.dx);
    const ms = Math.max(1, Date.now() - s.t0);
    return dist >= Math.max(72, s.width * 0.3) || (dist >= 36 && dist / ms >= 0.5);
  }

  /** 不切了：这一趟摆出去的样子滑回原位，进来的那个重新藏起来。 */
  function swipeSpringBack(p) {
    if (!p || !p.fromView || !p.toView) { messagesEl.classList.remove("swiping"); return; }
    const from = p.fromView;
    const to = p.toView;
    slideTo(from, 0, SWIPE_FINISH_MS);
    slideTo(to, p.dir === "next" ? p.width : -p.width, SWIPE_FINISH_MS);
    afterSlide(to, () => {
      clearSlideStyles(from);
      clearSlideStyles(to);
      to.classList.add("off");
      messagesEl.classList.remove("swiping");
    });
  }

  /** 能不能从这一下起一趟：落在对话区里、没落在横着能滚的东西上。（按住不放还没走的） */
  function swipeStart(e, x, y, finger) {
    // 上一趟还在等后端回话（或者正在滑完）：这一下不接，不然两个壳的摆法会打起来
    if (pendingSlide || swipe) { return false; }
    const view = e.target && e.target.closest ? e.target.closest(".session-view") : null;
    const cur = activeSession();
    if (!view || !cur || view !== cur.viewEl) { return false; }
    if (swipeStartsInScrollable(e.target)) { return false; }
    swipe = {
      finger: finger, x0: x, y0: y, t0: Date.now(), lock: "", dir: "", dx: 0, eff: 0,
      width: swipeWidth(), fromView: view, toView: null, to: null, toId: "", pointerId: 0,
    };
    return true;
  }

  /**
   * 动到 (x,y)：认成横划就摆两下壳、返回 true（调用方把浏览器自己的动作拦掉）。
   * 竖着先动起来就当场作废，这一趟不管了（那是滚动 / 选字）。
   */
  function swipeMove(x, y) {
    const s = swipe;
    if (!s) { return false; }
    const dx = x - s.x0;
    const dy = y - s.y0;
    if (!s.lock) {
      // 竖着先动起来：这是滚动（或者鼠标在选字），这一趟不管了
      if (Math.abs(dy) > SWIPE_CANCEL_PX && Math.abs(dy) > Math.abs(dx)) { swipe = null; return false; }
      // 横着得压过竖着才认（斜着划多半是想滚），但别再额外要“压过一半”：那样快划时要多等好几帧
      if (Math.abs(dx) < SWIPE_LOCK_PX || Math.abs(dx) < Math.abs(dy)) { return false; }
      s.lock = "x";
      s.dir = dx < 0 ? "next" : "prev";
      const toId = sessionIdByDirection(s.dir);
      const to = toId ? sessions.get(toId) : null;
      // 只有一个会话：没得换，也就不摆样子（不拦，让人家照旧）
      if (!to || !to.viewEl) { swipe = null; return false; }
      s.toId = toId;
      s.to = to;
      s.toView = to.viewEl;
      swipeBegin(s);
    }
    s.dx = dx;
    s.eff = swipeOffset(dx, s.width);
    swipePlace(s);
    return true;
  }

  /**
   * 鼠标这一下是不是正好压在字上（压在字上是要选字，不切会话）。
   * 判法：取这一点最近的插入光标，再量它旁边那几个字占的那一小块地：
   * 这一点落在里面就算有文字；字与字之间、气泡右侧的空地、两条消息之间的缝都算没有文字。
   * 只量光标旁边三个字（不是整个文字节点）：一大段代码里一按就量上千行的事儿不发生。
   */
  function swipeHitsText(x, y) {
    let node = null;
    let at = 0;
    try {
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        node = r && r.startContainer;
        at = r ? r.startOffset : 0;
      } else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        node = p && p.offsetNode;
        at = p ? p.offset : 0;
      }
    } catch (e) { return false; }
    if (!node || node.nodeType !== 3 || !(node.nodeValue || "").trim()) { return false; }
    const text = node.nodeValue || "";
    // 左右各带一点：光标可能停在这一点的左边那一侧
    const from = Math.max(0, at - 2);
    const to = Math.min(text.length, at + 1);
    try {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to > from ? to : Math.min(text.length, from + 1));
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const b = rects[i];
        if (y >= b.top - 1 && y <= b.bottom + 1 && x >= b.left - 2 && x <= b.right + 2) { return true; }
      }
    } catch (e) { /* 量不出来就当没文字 */ }
    return false;
  }

  /** 鼠标这一下落在按钮 / 链接 / 图这类“按下去有作用”的东西上：别拿它切会话。 */
  function swipeOnControl(el) {
    return !!(el && el.closest && el.closest("button, a, input, textarea, select, img, video, summary, label, [contenteditable='true']"));
  }

  // 两种按法走同一套：
  // · 手机（手指、笔）：横着一动就跟手走，认成横划就 preventDefault，把这一下从浏览器手里拿过来；
  //   竖着不拦，照旧滚动。这里用 touch 事件而不是 pointer：横向一放下，浏览器会拿指针事件去做它自己的手势
  //   （滚动 / 前进后退），pointercancel 一来追踪就断了，而 touchmove 一直在。
  // · 电脑（鼠标）：只从**没有文字**的地方按住拖（从文字上按下还是老老实实选字，见 swipeHitsText），
  //   按钮 / 链接上也不接。
  messagesEl.addEventListener("touchstart", (e) => {
    // 已经在划了又来一根手指（缩放之类）：这一趟作废，摆出去的样子弹回去
    if (swipe) { swipeAbort(); return; }
    if (e.touches.length !== 1) { return; }
    const t = e.touches[0];
    swipeStart(e, t.clientX, t.clientY, t.identifier);
  }, { passive: true });

  messagesEl.addEventListener("touchmove", (e) => {
    const s = swipe;
    if (!s) { return; }
    if (e.touches.length !== 1) { swipeAbort(); return; }
    const t = e.touches[0];
    if (t.identifier !== s.finger) { swipeAbort(); return; }
    // 认成横划了：这一下不给浏览器（不然它会去滚 / 去翻页）
    if (swipeMove(t.clientX, t.clientY) && e.cancelable) { e.preventDefault(); }
  }, { passive: false });

  messagesEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) { return; }
    if (swipeOnControl(e.target)) { return; }
    if (swipeStartsInScrollable(e.target)) { return; }
    if (swipeHitsText(e.clientX, e.clientY)) { return; }
    if (!swipeStart(e, e.clientX, e.clientY, "mouse")) { return; }
    swipe.pointerId = e.pointerId;
    // 按住了就一直跟着走：拖到对话区外面也不断（不然手一快就丢）
    try { messagesEl.setPointerCapture(e.pointerId); } catch (err) { /* 捕获不到就靠冒泡 */ }
  });

  messagesEl.addEventListener("pointermove", (e) => {
    const s = swipe;
    if (!s) { return; }
    if (s.finger === "mouse") {
      if (e.pointerId !== s.pointerId) { return; }
      // 鼠标拖着越过文字时，浏览器会顺手把这一段选中。以前是划的时候给 #messages 盖上
      // user-select: none 挡住的，可那一下要重算整棵消息树的样式，正好卡在手指刚动的那一帧
      // （见 chat.css 那段）：改成每帧自己抹掉，看得见的只剩“在切会话”这件事。
      if (swipeMove(e.clientX, e.clientY)) { dropSelection(); }
      return;
    }
    // 手指：安卓会把头几下的 touchmove 压到“手指挪过一小段”之后才发给我们（就是在手机量到
    // 那四五十毫秒的“手指动了、画面不动”）。指针事件来得早得多（同一台机上量：指针事件
    // 第一下 31 毫秒就到了、才挪了 2 像素；touchmove 要等到 232 毫秒），所以先用它把
    // “这是横着划”认下来，后面照旧由 touchmove 接着喂位置（touchmove 一到就 preventDefault，
    // 浏览器就不会拿这个手势去滚）。
    if (e.pointerType === "mouse" || !e.isPrimary) { return; }
    swipeMove(e.clientX, e.clientY);
  });

  messagesEl.addEventListener("pointerup", (e) => {
    const s = swipe;
    if (!s || s.finger !== "mouse" || e.pointerId !== s.pointerId) { return; }
    swipeEnd(false);
  });

  messagesEl.addEventListener("pointercancel", (e) => {
    const s = swipe;
    if (!s || s.finger !== "mouse" || e.pointerId !== s.pointerId) { return; }
    swipeAbort();
  });

  // 兜底：拖到窗口外再松手、被别的东西抢走了指针这类：捕获一丢就把这一趟收回去
  messagesEl.addEventListener("lostpointercapture", (e) => {
    const s = swipe;
    if (!s || s.finger !== "mouse" || e.pointerId !== s.pointerId) { return; }
    swipeAbort();
  });

  /** 这一趟作废（第二根手指按上来、手指换了之类）：摆出去的样子弹回去。 */
  function swipeAbort() {
    const s = swipe;
    swipe = null;
    if (s && s.lock === "x") { swipeSpringBack(s); }
  }

  /** 手抬起来了（或者被打断）：按位置决定切不切（取消的那种直接弹回去）。 */
  function swipeEnd(cancelled) {
    const s = swipe;
    swipe = null;
    if (!s || s.lock !== "x") { return; }
    if (cancelled || !swipePast(s)) { swipeSpringBack(s); return; }
    // 松手：一边跟后端要那个会话，一边当场把画面滑到位。
    // 不等它回话再滑：快划时松手得很快，等那几十毫秒就冻住一瞬（回话只决定“算不算切过去”）。
    const slide = {
      dir: s.dir, toId: s.toId, width: s.width,
      fromView: s.fromView, toView: s.toView, to: s.to,
      endX: s.dir === "next" ? -s.width : s.width,
      timer: 0, landed: false,
    };
    slide.timer = setTimeout(() => {
      if (pendingSlide !== slide) { return; }
      pendingSlide = null;
      swipeSpringBack(slide);
    }, SWIPE_WAIT_MS);
    pendingSlide = slide;
    if (s.to) { slideToPlace(slide, s.to); }
    vscode.postMessage({ type: "switchSession", sessionId: s.toId });
  }

  messagesEl.addEventListener("touchend", (e) => {
    const s = swipe;
    if (!s) { return; }
    const t = e.changedTouches && e.changedTouches[0];
    if (!t || t.identifier !== s.finger) { return; }
    swipeEnd(false);
  });
  messagesEl.addEventListener("touchcancel", (e) => {
    const s = swipe;
    if (!s) { return; }
    const t = e.changedTouches && e.changedTouches[0];
    if (!t || t.identifier !== s.finger) { return; }
    swipeEnd(true);
  });

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
    const norm = (p) => pathCaseKey(p).replace(/\/+$/, "");
    return norm(a) === norm(b);
  }

  /** 拿一个目录当“同一个目录”用的键（跟 samePath 一个规矩）。 */
  function normPathKey(p) {
    return pathCaseKey(p).replace(/\/+$/, "");
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

  /** 这个会话现在是不是在跑（会话列表上那颗“在跑”的小点看的就是它）。
   *  关它之前要不要再问一句，就看这一个：跑着的会话关下去会打断这一轮，闲着的没什么可丢。 */
  function sessionRunning(id) {
    const st = id ? sessions.get(id) : null;
    return !!(st && st.streaming);
  }

  /** 关一个会话：这一下就走（会话文件留着，历史列表里能重新打开；
   *  关掉的正是正在看的那个，后端会把这块屏切到别的会话去）。 */
  function closeSession(id) {
    // 列表不关：关掉一条后马上就能接着关下一条（那一行会跟着会话列表自己消失）
    vscode.postMessage({ type: "closeSession", sessionId: id });
  }

  /** 把“等确认”那一行撤回去（点取消、点行身切会话、干等超时都走它）：只抹状态，重画交给调用方。 */
  function cancelPendingClose() {
    pendingCloseId = null;
    if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
    pendingCloseTimer = null;
    refreshSessionTabClose();
  }

  /**
   * 请求关闭某个会话（行尾那颗叉、快捷键都走这儿）。
   * 已经跑完：不必问，一下就关。正在跑：这一下只把那一行变成确认条（整行变红、行尾多一颗勾），
   * 再点勾才真关（防误触，也免得不小心把跑着一半的一轮打断）。
   */
  function askCloseSession(id) {
    // 已经问过了（确认条上那颗勾）：真关
    if (pendingCloseId === id) {
      cancelPendingClose();
      closeSession(id);
      return;
    }
    // 没在跑：不用问第二遍（可能已经跑完了，状态还没来得及推过来）
    if (!sessionRunning(id)) {
      closeSession(id);
      return;
    }
    // 点第一下（某一行转成确认条）：就手把清单现在的宽度记下来钉住，
    // 行尾多出一颗勾也不许把整张清单撑宽（钉住的值在 placeSessionMenu 里用）。
    if (sessionMenuOpen && !pendingCloseId) { sessionMenuPin = sessionMenuEl.offsetWidth; }
    pendingCloseId = id;
    refreshSessionTabClose();
    if (pendingCloseTimer) { clearTimeout(pendingCloseTimer); }
    pendingCloseTimer = setTimeout(() => {
      cancelPendingClose();
      refreshOpenSessionsInPicker();
      refreshSessionMenu();
    }, 4000);
    refreshOpenSessionsInPicker();
    refreshSessionMenu();
  }

  /**
   * 「正在对话」那一段的内容指纹（只算真会影响列表长相的字段）。
   * 带上开着的会话各自是哪个文件：上半那些「历史会话」行靠它标「已打开」。
   */
  function openSessionsSignature(items) {
    const files = Array.from(sessions.values()).map((t) => t.sessionFile || "").sort().join(",");
    return files + "\u0000" + items.map((it) => [
      it.sessionId, it.label || "", it.depth || 0, it.current ? 1 : 0,
      it.streaming ? 1 : 0, it.loading ? 1 : 0, it.turnDone ? 1 : 0,
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
   * 会话增减 / 状态变化：列表开着就把变了的那一块重画一遍。
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
    // 常驻那一列收起了：那份内容留着不再跟着重画（展开时会整份要一份新的，见 expandSidebar）
    if (view === dockView && !sidebarDocked()) { return; }
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
      if (old.done || old.cardJson === cardJson) {
        // 重放对账中：这张卡片得“报到”，否则会被当成历史里已经没有的东西收掉
        if (st.reconcile) { placeUnit(st, old.el, true); }
        return;
      }
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
    el.className = "msg ask-card" + enterCls(st);
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
    if (st.reconcile) { placeUnit(st, el, true); }
    else if (anchor) { anchor.after(el); }
    else { st.paneEl.appendChild(el); }
    // 卡片算一道坎：后面的工具标签另起一行（画在卡片下面，不往上面那条工具行里钻）
    st.currentToolTail = null;
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
    cancelPendingClose();
    view.state = null;
    if (view === modalView) { emptyWorkspace = ""; }   // 那张抽屉没了：“替没有会话摊开”的账也结掉
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
  /**
   * 窄窗里那张抽屉是替“一个会话都没有”自己摊开的（不是人点的 <<<）：空串 = 不是，
   * "asked" = 跟宿主要了、还在路上，"shown" = 已经画出来了。有会话了就把这种抽屉收起来；
   * 面板还在路上（要扫一眼磁盘才拼得出来）的时候会话已经开好了，那就不弹了。
   */
  let emptyWorkspace = "";

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
  /** 这一列此刻在屏上画着面板吗（那一列留没留、那份内容画没画出来）。 */
  function sidebarDocked() { return sidebarEnabled() && !!dockView.state; }
  /** 手里还留着上一回画出来的那份吗：收起之后也留着（再展开先摆它，见 expandSidebar）。 */
  function sidebarHasContent() { return !!dockView.state; }
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
    // 左边那一列的宽度也算进键里：对话那边一变宽窄，顶条里那排会话格的高度可能就变了
    //（拖宽度拖完定下来的那一下会调到这里，见 wireFileSidebarResize）。
    // 那一排格自己的高度也算进来：派出去的子会话在跑时小点底下多一个数，整条会高两个像素。
    const key = (document.body.style.getPropertyValue("--vscode-font-size") || "") + "|" +
      Math.ceil(sessionTabRow.getBoundingClientRect().height) + "|" + window.innerWidth + "|" +
      (rightDock ? "r" : "") + (fileDock ? "l" + Math.round(fileSidebar.width) + "|" : "");
    if (key === dockBarKey) { return; }
    bar.style.height = "";
    const h = Math.ceil(bar.getBoundingClientRect().height);
    bar.style.height = h + "px";
    if (rightDock) { dockView.header.style.height = h + "px"; }
    if (fileDock && fileHeader) {
      // 这一列的头就是一排标签：顶条那点高不够时装不下标签时以这一列自己的内容为准，
      // 够的时候两边照样齐（那根横线才落在同一条线上）。
      fileHeader.style.height = "";
      const own = Math.ceil(fileHeader.getBoundingClientRect().height);
      fileHeader.style.height = Math.max(h, own) + "px";
    }
    dockBarKey = key;
  }

  /**
   * 常驻那一列底部的「设置」那块跟对话那边的输入区同高：这一块的顶边与输入区的顶边
   * 落在同一条横线上（跟上面面板头那两根顶线一个道理；那两根线如今只对齐位置，不再画线）。
   * 输入区的高度是跟内容走的（输入框长高一行、贴了附件、排队的消息多一条都会变），所以不写死，
   * 每回现量：“从输入区顶边量到这一列的底边”，量出来多高就把它多高。
   * 直接量两个边、不要各自取整再相减：那样两点会错开半个像素，看着发虚。
   * 那块高起来的时候，里头的按钮贴着底边（见 chat.css 的 #dockFooter）：顶边往上走，按钮不动。 */
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

  /**
   * 右边那一列该有内容、而现在没画着：跟宿主再要一份。
   * @param refresh 手里留着上一回那份也照要（展开时用：先把旧的那份摆出来，新的回来只补真变了的那几格）
   */
  function ensureSidebarPanel(refresh) {
    if (!sidebarEnabled() || sidebarAsked) { return; }
    if (!refresh && sidebarHasContent()) { return; }
    sidebarAsked = true;
    vscode.postMessage({ type: "openWorkspace", dock: true, expanded: expandedDirsForHost() });
    // 万一这条消息丢了（刚重连上那一阵、宿主那头正开着别的浮层）：过几秒放行，下一回再要
    setTimeout(() => { sidebarAsked = false; }, 5000);
  }

  /**
   * 一个会话都没有的那块空档（后端刚起、或者刚把最后几个关完）：把「项目与会话」摊开等人挑。
   * 宽窗摊成右边那一列，窄窗（手机、窄面板）是从右边滑进来的那张抽屉。
   * 这一次不看“收没收起”那个记忆——收起了也照摊（不摊开这块屏就没地方可点），但也不去改它。
   */
  function openWorkspaceForEmpty() {
    if (viewShowing("workspace")) { return; }   // 已经画着了（常驻那一列，或浮层里那张）
    if (sidebarWide()) {
      sidebarWanted = true;
      syncSidebarLayout();
      // 留着的那份这会儿可能是旧的（会话都关完了，它还在列“正在对话”那几行）：摆出来的同时再要一份新的
      ensureSidebarPanel(true);
      return;
    }
    if (emptyWorkspace) { return; }   // 已经摊开了、或者正在路上（会话列表可能连着来两次）
    // 两边同一时刻只开一块（跟点 <<< 那一套一样）
    closeFileSidebarForRightSidebar();
    emptyWorkspace = "asked";
    vscode.postMessage({ type: "openWorkspace", expanded: expandedDirsForHost() });
  }

  /** 展开常驻那一列（点 <<< 或面板里那颗叉的对面那种情形），并把“展开”记住。 */
  function expandSidebar() {
    // 窄窗里这一列与左边那一列同一时刻只留一块：先把左边收起来
    closeFileSidebarForRightSidebar();
    sidebarWanted = true;
    rememberSidebarWanted(true);
    sidebarAsked = false;
    syncSidebarLayout();
    // 收起时那一列里画着的那份留着没拆：这会儿它就跟着那一列一起回到屏上，点开立刻有东西。
    // 里头「正在对话」那几行是收起当时的，先用手里这份会话状态就地补一下（不扫磁盘，几毫秒）；
    // 工作区那一块接着再跟宿主要一份新的（扫一眼磁盘，看看这期间有没有新建 / 关掉会话），
    // 回来的那份由 paintWorkspacePanel 按格比，只有真变了的那几格重画 —— 看着不闪。
    refreshOpenSessionsIn(dockView);
    ensureSidebarPanel(true);
  }

  /** 收起常驻那一列：那一列从屏上拿掉，里头画着的那份留着（再展开先摆它，见 expandSidebar）。 */
  function collapseSidebar() {
    sidebarWanted = false;
    sidebarAsked = false;
    rememberSidebarWanted(false);
    syncSidebarLayout();
    // 正等着人点“勾”的那行确认条跟着收掉：收起之后那条确认没意义了（再展开时重推一份会重画那几格）
    cancelPendingClose();
  }

  /** 顶条那颗 <<< ：宽窗是常驻的收起 / 展开，窄窗照旧弹一次抽屉。 */
  function toggleSidebar() {
    if (!sidebarWide()) {
      // 窄窗：开了就收、没开就滑进来。开这一次不改变“宽窗要不要常驻”那个记忆。
      const st = modalView.state;
      if (st && st.kind === "workspace" && !modalView.root.classList.contains("hidden")) { cancelPicker(modalView); return; }
      // 两边同一时刻只开一块：左边那块开着就先收起来
      closeFileSidebarForRightSidebar();
      emptyWorkspace = "";   // 这一下是人自己点的
      vscode.postMessage({ type: "openWorkspace", expanded: expandedDirsForHost() });
      return;
    }
    if (sidebarEnabled()) { collapseSidebar(); } else { expandSidebar(); }
  }

  // 换窗口宽窄（拖边、转手机屏幕）：跨过那道门槛时把版面与面板跟着换过来
  let sidebarResizeFrame = 0;
  /** 上一回那一列在不在宽窗这一边：从窄变宽时跟宿主要一份新的（一直宽着的拖动就不用）。 */
  let sidebarWasWide = sidebarWide();
  window.addEventListener("resize", () => {
    if (sidebarResizeFrame) { return; }
    sidebarResizeFrame = requestAnimationFrame(() => {
      sidebarResizeFrame = 0;
      const wide = sidebarWide();
      const crossed = wide !== sidebarWasWide;
      sidebarWasWide = wide;
      syncSidebarLayout();
      if (!wide) {
        // 变窄了：常驻那一列装不下，CSS 把它整个藏起来（记忆不动：拉宽回来还会自己起来）；
        // 里头那份也留着，拉宽回来先摆它
        sidebarAsked = false;
        return;
      }
      // 从窄变宽（那一列刚回来）：摆着的那份可能旧了，要一份新的；一直宽着的拖动就别再要了
      ensureSidebarPanel(crossed);
    });
  });

  // ==================== 文件侧边栏（只在浏览器页面里）====================
  //
  // 点消息流里的文件链接，左边开出一列，只读地显示那个文件：带行号，停在链接说的那一行并高亮。
  // 内容由后端那条只读的文件地址（/file）按当前会话的目录读出来，不经过编辑器——手机上、
  // 或者只跑了后端没开编辑器的时候，点链接才有着落。
  //
  // 只有浏览器页面里有它：插件里的对话面板里点链接照旧交给编辑器打开。判据就是上面那个
  // IN_WEBVIEW 标记（界面桥放在 window 上的，跟顶条上那颗桌面截图按钮同一路）。
  //
  // 看过的文件在这一列头上排成一排标签：再点别的文件就多一个标签、原来那个还留着；点一个
  // 已经开着的文件就切回它那个标签、按这次链接说的行滚过去（同一个文件只留一个标签）；
  // 标签上那颗叉把它关掉；全关光后这一列不收起，留一句提示。标签只在这一趟页面上记着，
  // 刷新就没了（开没收起是记在这台设备里的，那个留着）。
  //
  // 第一个标签是「目录」（当前会话的目录）：点链接看的文件排在它后面的新标签里，不顶掉它。
  // 它没有那颗叉（关不掉），一直在最前面；列那一格走的是票 05 那套（同一条 `/dir` 地址，
  // `.` 表示会话目录自己）。
  //
  // 目录不占标签：点消息流里的目录链接、点清单里的子目录，都在「目录」这一格里换内容
  //（切到那一格、把这一层列出来），往回的「上一层」是清单里的第一行——到会话目录本身那一层就没有
  // 这一行了（不许走到会话目录外面去）。标签上一直写「目录」，现在在哪一层只看它的悬停提示
  //（给的是这一层的全路径）——这一列头上不另写路径。
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
  // html 那一族例外：不画成正文，摆一个 iframe 把那张网页真渲染出来（见 renderFileHtml）。它吃的是
  // 另一条地址 `/site/<会话>/<相对路径>`（路径就在地址里，页面里的相对引用才解析得对），
  // 文件改没改由 HEAD 问一下修改时间（见 pollHtmlFile）。
  //
  // 窗口够宽（≥1200px）时这一列常驻在左边、对话让出这块宽度；窄了从左边滑入、点外面收起。
  // 手机上同一时刻只开一块侧边栏：开左边这块就把右边那块收起来，反过来也一样
  //（两块都常驻时不受这条约束）。开没收起记在这台设备里（跟右边那一列同一个做法）。
  const FILE_SIDEBAR_MIN_WIDTH = 1200;
  /**
   * 这一列拖起来能有多窄多宽（两边都封死：比 300 还窄就放不下一行代码，比 1200 还宽对话那边
   * 就没地方了）。常驻时还要再跟「窗口宽度 − FILE_SIDEBAR_W_RESERVE」
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
   * 点链接问后端「这个名字对上了几个文件」最多等多久：后端自己那两道时限是 10 秒（有 rg）
   * 与 4 秒（没 rg、自己走目录），这边留出余量。等不到才按写的那样硬开。
   */
  const FILE_CANDIDATES_WAIT_MS = 12000;
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
  /** 「目录」那一格：标签上就写这两个字，悬停提示给这一层的全路径（见 fileSidebarProjectFullPath）。 */
  const FILE_SIDEBAR_PROJECT_NAME = "文件";
  /** 「改动」那一格：这个会话改了哪些文件、每个改成什么样（标签上就写这两个字）。 */
  const FILE_SIDEBAR_CHANGES_NAME = "改动";
  /** 这一格里一个文件都没改过时那句提示。 */
  const FILE_SIDEBAR_CHANGES_HINT = "这个会话还没改过文件。";
  /** 「后台」那一格：这个会话放到后台跑的命令、跑到哪一步了（标签上就写这两个字）。 */
  const FILE_SIDEBAR_SCRIPTS_NAME = "后台";
  /** 这一格里一条后台命令都没有时那句提示。 */
  const FILE_SIDEBAR_SCRIPTS_HINT = "这个会话还没有放到后台跑的命令。";
  /** 问后端「会话目录自己」用这个相对写法（列目录那条地址不认空路径，`.` 就是会话目录）。 */
  const FILE_SIDEBAR_PROJECT_PATH = ".";
  /** 这一列那一摊：容器、里面那几块、开着哪几个文件。 */
  const fileSidebar = {
    root: null, header: null, title: null, tabsEl: null, body: null, resize: null,
    bar: null, barName: null, closeFile: null,
    open: false,     // 这台设备上人要不要它开着（记在 localStorage；开着时宽窗常驻、窄窗滑入）
    // 人拖出来的宽度（像素数，也记在本机里）：没拖过就是 FILE_SIDEBAR_W_DEFAULT。
    // 写到版式上的那个值还可能被窗口收小，但这里留着的永远是原值（见 applyFileSidebarWidth）。
    width: 0,
    wrap: false,     // 长行折起来还是横向滚（记在 localStorage；默认一行就是一行，见 chat.css 末尾）
    // 常驻的三格（文件 / 改动 / 后台），从左到右：[{ path, home, proj, dir, line, scrollTop, mtime, loading, imageUrl, page, drawn }]
    //（不记进设备，刷新就没了）
    //   home：这是「文件」那一格（排在最前、没有关闭那颗叉）
    //   proj：这一格现在在列清单（true）还是在显示一个文件（false）
    //   path：清单模式是它现在待的那一层（相对会话目录：`.` 就是会话目录自己）；
    //   文件模式是那个文件的写法
    //   dir：进文件之前待的那一层：点右上角那颗关闭回这里（见 backToFileList）
    //   mtime：画在这一列上的那份内容的修改时间（下次问「变了没」时带上去）
    //   loading：还在取（正文那块写着「正在读取…」）
    //   imageUrl：图片那个显示地址（blob:…）；换成别的图或关掉标签时要放掉它
    //   page：这一格自己那一块正文（挂在 #fileBody 下面，切走时只是藏起来，不重画）；
    //   切回来直接摆上——网页那个 iframe 挪一次位置就会重新加载，所以谁也不挪，只换露哪一块
    //   drawn：那一块里已经有画好的内容了（切回来不必再去后端取）
    tabs: [],
    active: -1,      // 现在看的是哪一个标签（下标）；一个都没开就是 -1
    token: 0,        // 取文件是异步的：换标签 / 收起之后回来的旧回应就不算数了
    hintPage: null,  // 一个标签都没开时那句提示画在哪儿（跟标签那几块同一层，只露一块）
    sessionId: null,  // 现在手头这一份标签是哪个会话的（见 resetFileSidebarForSession）
  };
  /** 上一条「变了没」的询问还在路上（手机网慢）：这一轮先不发，别越堆越多。 */
  let filePolling = false;

  /** 窗口够宽吗（够宽这一列常驻，不够就是滑入式）。 */
  function fileSidebarWide() { return window.innerWidth >= FILE_SIDEBAR_MIN_WIDTH; }
  /** 这一列此刻常驻在左边吗。 */
  function fileSidebarDocked() { return fileSidebar.open && fileSidebarWide(); }
  /**
   * 这一列此刻能不能拖宽度：常驻时能；PC 上从左边滑入的那一层也能。
   * 手机上滑入的那一层铺满整屏，宽度归窗口管，那条缝也不露面（见 chat.css 的 #fileResize）。
   */
  function fileSidebarResizable() {
    return fileSidebar.open && !document.body.classList.contains("file-full");
  }

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
   * 拖的时候这一列最宽能到多少：常驻时跟上面那个一样（给对话留 360）；滑入时再按 chat.css
   * 那条 `min(…, 86vw)` 收一道——松手后宽度回到 CSS 上，屏幕上不该跳一下。
   */
  function clampFileSidebarDragWidth(px) {
    const base = clampFileSidebarWidth(px, fileSidebarDocked());
    if (fileSidebarDocked()) { return base; }
    return Math.min(base, Math.max(FILE_SIDEBAR_W_MIN, Math.floor(window.innerWidth * 0.86)));
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
    syncFileBar();   // 开着 / 收起变了：那条横条跟着换
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
   * 「目录」那一格现在这一层的全路径（`.` 那一层就是会话目录本身）：标签的悬停提示写它
   *（这一列头上不再写路径，进到哪一层只看这个提示，见 renderFileTabs）。
   */
  function fileSidebarProjectFullPath(tab) {
    const base = activeSessionCwd();
    if (!base) { return FILE_SIDEBAR_PROJECT_NAME; }
    if (tab.path === FILE_SIDEBAR_PROJECT_PATH) { return base; }
    const sep = base.indexOf("\\") >= 0 ? "\\" : "/";
    return base.replace(/[\\/]+$/, "") + sep + String(tab.path).replace(/\//g, sep);
  }

  /** 一格标签悬停提示上的全路径：目录那一格是它现在待的那一层。 */
  function fileSidebarTabFullPath(tab) {
    if (tab.change) { return FILE_SIDEBAR_CHANGES_NAME; }
    if (tab.scriptsTab) { return FILE_SIDEBAR_SCRIPTS_NAME; }
    return tab.proj ? fileSidebarProjectFullPath(tab) : tab.path;
  }

  /** 标签上那行字：文件名。全路径太长，标签上停一下有提示。 */
  function fileSidebarTabName(path) {
    return String(path).replace(/\\/g, "/").split("/").pop() || String(path);
  }


  /** 「目录」那一格在标签条上的下标（没有就是 -1）。 */
  function fileSidebarProjectIndex() {
    for (let i = 0; i < fileSidebar.tabs.length; i++) { if (fileSidebar.tabs[i].home) { return i; } }
    return -1;
  }

  /** 「文件」那一格的字段（它一开始在列清单；点开文件就变成显示文件）。 */
  function fileSidebarNewTab(path, proj) {
    return {
      path: path, home: true, proj: !!proj, dir: path, line: 0, scrollTop: 0,
      mtime: "", loading: false, imageUrl: "",
      page: null,    // 这一格自己那一块正文（见 fileTabPage）
      drawn: false,  // 那一块里已经有画好的内容了
    };
  }

  /**
   * 「改动」那一格：这个会话改过哪些文件（后端给的清单）、哪几个块是展开的、取回来的 diff。
   * 它不像文件那样按 path 取内容，所以 path 留空；每回摆上这一格都重问一遍清单（见 showFileTab）。
   */
  function fileSidebarNewChangesTab() {
    return {
      path: "", proj: false, change: true, line: 0, scrollTop: 0, mtime: "", loading: false, imageUrl: "",
      page: null,
      drawn: false,
      changes: [],      // 后端给的清单：{ path, added, removed, deleted, tooBig }
      open: new Set(),  // 展开了哪几个文件（相对写法）
      diffs: new Map(), // 取回来的 diff 文字（相对写法 → 文字）
    };
  }

  /**
   * 「后台」那一格：这个会话放到后台跑的命令（后端给的清单）、哪几行展开着、取回来的输出。
   * 跟「改动」一样不按 path 取内容，所以 path 留空；每回摆上这一格都重问一遍清单（见 showFileTab）。
   */
  function fileSidebarNewScriptsTab() {
    return {
      path: "", proj: false, scriptsTab: true, line: 0, scrollTop: 0, mtime: "", loading: false, imageUrl: "",
      page: null,
      drawn: false,
      scripts: [],      // 后端给的清单：{ no, cmd, log, pid, startedAt, status, exitCode, elapsedMs, ... }
      open: new Set(),  // 展开了哪几条（任务编号）
      logs: new Map(),  // 取回来的输出（任务编号 → 文字）
    };
  }

  /**
   * 把「目录」那一格摆到标签条最前面（只摆、不取内容）：这一列里没有它的时候摆。
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

  /** 「改动」那一格在标签条上的位置（没有就是 -1）。 */
  function fileSidebarChangesIndex() {
    for (let i = 0; i < fileSidebar.tabs.length; i++) { if (fileSidebar.tabs[i].change) { return i; } }
    return -1;
  }

  /** 「后台」那一格在标签条上的位置（没有就是 -1）。 */
  function fileSidebarScriptsIndex() {
    for (let i = 0; i < fileSidebar.tabs.length; i++) { if (fileSidebar.tabs[i].scriptsTab) { return i; } }
    return -1;
  }

  /**
   * 把「改动」那一格摆上（只摆、不取内容）：它是常驻的一格，固定在「目录」后面、
   * 排在所有文件标签前面。会话目录还不认识就不摆（跟「目录」同一个条件）。
   * @returns 摆了没有
   */
  function addChangesTab() {
    if (!fileSidebar.root || fileSidebarChangesIndex() >= 0) { return false; }
    if (!activeSessionCwd()) { return false; }
    const at = fileSidebarProjectIndex() >= 0 ? fileSidebarProjectIndex() + 1 : 0;
    fileSidebar.tabs.splice(at, 0, fileSidebarNewChangesTab());
    if (fileSidebar.active >= at) { fileSidebar.active++; }   // 挪下标：正看着的那一格不变
    return true;
  }

  /**
   * 把「后台」那一格摆上（只摆、不取内容）：它也是常驻的一格，排在「改动」后面。
   * 会话目录还不认识就不摆（跟「目录」「改动」同一个条件）。
   * @returns 摆了没有
   */
  function addScriptsTab() {
    if (!fileSidebar.root || fileSidebarScriptsIndex() >= 0) { return false; }
    if (!activeSessionCwd()) { return false; }
    const changesAt = fileSidebarChangesIndex();
    const at = changesAt >= 0 ? changesAt + 1 : (fileSidebarProjectIndex() >= 0 ? fileSidebarProjectIndex() + 1 : 0);
    fileSidebar.tabs.splice(at, 0, fileSidebarNewScriptsTab());
    if (fileSidebar.active >= at) { fileSidebar.active++; }   // 挪下标：正看着的那一格不变
    return true;
  }

  /**
   * 这一列开着又空着（一个标签都没有）的时候，摆上「目录」那一格并显示它：
   * 刚打开、切会话、刷新页面走的都是这里；会话目录还没认识就留一句提示。
   */
  function ensureProjectDirTab() {
    if (!fileSidebar.root || !fileSidebar.open || fileSidebar.active >= 0) { return; }
    if (addProjectDirTab()) {
      addChangesTab();   // 「改动」那一格跟着一起来（固定排在「目录」后面）
      addScriptsTab();   // 「后台」那一格跟在「改动」后面
      showFileTab(0, 0);
      return;
    }
    showFileNote(FILE_SIDEBAR_HINT);
  }

  /** 把现在这一格读到哪儿记进它那个标签（切走、重画之前）。 */
  function rememberFileTabScroll() {
    const tab = fileSidebar.tabs[fileSidebar.active];
    if (tab && fileSidebar.body) { tab.scrollTop = fileSidebar.body.scrollTop; }
  }

  /**
   * 一个标签自己那一块正文：每个标签一块，都挂在 #fileBody 下面，同一时刻只露正看着的那一块。
   * 切标签时不动里面画好的东西（网页那个 iframe 从文档里挪一次就会重新加载），只换露不露。
   * 一块都还没建就先建一个。
   */
  function fileTabPage(tab) {
    if (!tab || !fileSidebar.body) { return null; }
    if (!tab.page) {
      tab.page = document.createElement("div");
      tab.page.className = "file-page";
      fileSidebar.body.appendChild(tab.page);
    }
    return tab.page;
  }

  /** 一个标签都没开时那句提示画在哪儿（跟标签那几块同一层，只露一块）。 */
  function fileHintPage() {
    if (!fileSidebar.body) { return null; }
    if (!fileSidebar.hintPage) {
      fileSidebar.hintPage = document.createElement("div");
      fileSidebar.hintPage.className = "file-page";
      fileSidebar.body.appendChild(fileSidebar.hintPage);
    }
    return fileSidebar.hintPage;
  }

  /**
   * 正文上面那条横条：只有「文件」那一格在看一个文件时露出来，左边是这个文件的写法
   * （相对会话目录，一行放不下就省略、悬停看全），右边一颗关闭（点了回清单，见 backToFileList）。
   * 它摆在正文外面（#fileBody 是滚动的那一块），所以往下拖的时候它一直看得见。
   */
  function syncFileBar() {
    const bar = fileSidebar.bar;
    if (!bar) { return; }
    const tab = fileSidebar.tabs[fileSidebar.active];
    const show = !!tab && !!tab.home && !tab.proj;
    // 角上那颗折行开关只在真看一个文件时露面：清单、「改动」「后台」那几格里没有长行可折
    const wrapBtn = document.getElementById("fileWrap");
    const viewingFile = !!tab && !tab.proj && !tab.change && !tab.scriptsTab;
    if (wrapBtn) { wrapBtn.hidden = !viewingFile; }
    bar.hidden = !show;
    if (!show) { return; }
    if (fileSidebar.barName) {
      fileSidebar.barName.textContent = tab.path;
      fileSidebar.barName.title = fileSidebarTabFullPath(tab);
    }
  }

  /** 正文里现在该画在哪儿：正看着的那个标签那一块；一个标签都没开就是这一列自己那一块。 */
  function filePage() {
    const tab = fileSidebar.tabs[fileSidebar.active];
    return tab ? fileTabPage(tab) : fileHintPage();
  }

  /** 正文里只露正看着的那一块（别的那几块留着，切回来直接摆上）。 */
  function syncFilePages() {
    if (!fileSidebar.body) { return; }
    const tab = fileSidebar.tabs[fileSidebar.active];
    const keep = tab ? fileTabPage(tab) : fileHintPage();
    Array.prototype.forEach.call(fileSidebar.body.children, (page) => {
      const hide = page !== keep;
      if (page.hidden !== hide) { page.hidden = hide; }
    });
  }

  /**
   * 在这一格已经画好的正文里跳到某一行：切回一个开着、内容还在的标签时用，不必重新读文件。
   * @returns 跳到了没有：这一块里没有那一行（图、目录，或者缓存旧了行数变少）给 false，调用方去重读
   */
  function jumpInFilePage(tab, line) {
    const page = fileTabPage(tab);
    const rows = page ? page.querySelectorAll(".file-line") : [];
    const row = rows[line - 1] || null;
    if (!row) { return false; }
    page.querySelectorAll(".file-line.hit").forEach((r) => r.classList.remove("hit"));
    row.classList.add("hit");
    scrollFileBody(row, line, tab.scrollTop);
    return true;
  }

  /**
   * 重画标签条：常驻三格（文件 / 改动 / 后台），点名字切过去。三格都不带那颗叉。
   * 「文件」那一格的名字一直写「文件」：看的是哪个文件，正文上面那条横条里写着（见 syncFileBar）。
   */
  function renderFileTabs() {
    const bar = fileSidebar.tabsEl;
    if (!bar) { return; }
    bar.innerHTML = "";
    fileSidebar.tabs.forEach((tab, i) => {
      const el = document.createElement("div");
      el.className = "file-tab" + (i === fileSidebar.active ? " active" : "");
      el.setAttribute("data-path", tab.path);
      if (tab.home) { el.setAttribute("data-proj", "1"); }
      if (tab.change) { el.setAttribute("data-changes", "1"); }
      if (tab.scriptsTab) { el.setAttribute("data-scripts", "1"); }
      el.title = fileSidebarTabFullPath(tab);   // 文件那一格悬停给现在这一层 / 这个文件的全路径
      const name = document.createElement("span");
      name.className = "file-tab-name";
      name.textContent = tab.home
        ? FILE_SIDEBAR_PROJECT_NAME
        : tab.change ? FILE_SIDEBAR_CHANGES_NAME : FILE_SIDEBAR_SCRIPTS_NAME;
      el.appendChild(name);
      el.addEventListener("click", () => showFileTab(i, 0));
      bar.appendChild(el);
    });
    // 开着的标签多了会往右跑出这一列：把现在这个带进来看得见的地方
    const active = bar.querySelector(".file-tab.active");
    if (active) { active.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  }

  /**
   * 摆上某一个标签：标签条、正文都跟着换。
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
    renderFileTabs();
    syncFilePages();
    syncFileBar();
    // 「改动」那一格不取文件内容：先摆上手上这一份，再问一遍清单（没画过就等取回来再画）
    if (tab.change) {
      if (tab.drawn) { fetchChanges(tab); } else { showFileNote("正在读取…"); fetchChanges(tab); }
      return;
    }
    if (tab.scriptsTab) {
      if (tab.drawn) { fetchScripts(tab); } else { showFileNote("正在读取…"); fetchScripts(tab); }
      return;
    }
    // 这一格以前画过：那一块还在，直接摆上（不必再去后端取；最多旧一个刷新节拍，
    // 下面顺手问一次「变了没」，变了就换成新的）
    if (tab.drawn) {
      if (linkLine > 0) {
        if (jumpInFilePage(tab, linkLine)) { pollActiveFile(); return; }
        // 没有那一行（图、目录，或者缓存旧了行数变少）：重新读一遍
      } else {
        scrollFileBody(null, 0, tab.scrollTop);
        pollActiveFile();
        return;
      }
    }
    showFileNote("正在读取…");
    loadIntoSidebar(linkLine);
  }

  /**
   * 把一格标签自己那块正文撤掉（关掉标签、切会话时）：这一块连着里面的东西一起不要了，
   * 图那个显示地址也放掉。标签本身还留着的话（切会话）下次摆上时重读一遍。
   */
  function dropFileTabPage(tab) {
    if (!tab) { return; }
    releaseTabImage(tab);
    if (tab.page && tab.page.parentNode) { tab.page.parentNode.removeChild(tab.page); }
    tab.page = null;
    tab.drawn = false;
  }

  /** 点标签上那颗叉：关掉这一个。全关光后这一列不收起，留一句提示。 */

  /**
   * 这一列里那一段纯粹的文字（提示、看不了的原因、正在读取）；看不了但能下载时一并放上链接。
   * 已经就是这一句（连同同一个下载地址）就别再重画：跟着刷新每轮都会来报「还是看不了」，
   * 而人可能正选着里面的字。
   * @param download 给了就在句末跟一颗下载链接：{ url, name, label }
   */
  function showFileNote(text, download) {
    if (!fileSidebar.body) { return; }
    const page = filePage();
    if (!page) { return; }
    const href = download ? download.url : "";
    const only = page.children.length === 1 ? page.firstElementChild : null;
    const oldText = only && only.firstElementChild ? only.firstElementChild.textContent : null;
    const oldLink = only && only.querySelector ? only.querySelector("a.file-download") : null;
    if (only && only.className === "file-note" && oldText === text
        && ((!oldLink && !href) || (oldLink && oldLink.getAttribute("href") === href))) {
      return;
    }
    page.innerHTML = "";
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
    page.appendChild(note);
    prependFileUpRow();
  }

  /**
   * 清单第一行那颗「上一层」：「目录」那一格待在某一层子目录里、而且正看着它的时候才有这一行
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

  /** 现在看着的「目录」那一格该有「上一层」这一行时，把它摆到正文最上面。 */
  function prependFileUpRow() {
    const page = filePage();
    if (!page) { return; }
    const row = buildFileUpRow(fileSidebar.tabs[fileSidebar.active]);
    if (row) { page.insertBefore(row, page.firstChild); }
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
    const page = filePage();
    if (!page) { return; }
    const url = URL.createObjectURL(blob);
    releaseTabImage(tab);
    tab.imageUrl = url;
    page.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "file-image";
    const img = document.createElement("img");
    img.className = "file-image-img";
    img.alt = fileSidebarTabName(tab.path);
    img.src = url;
    wrap.appendChild(img);
    page.appendChild(wrap);
  }

  /**
   * 清单里一行左边那颗图标：目录是文件夹，图片是它自己的小图（小了才挂，见 DIR_THUMB_MAX_BYTES；
   * 取不到也退回通用图标）——大图不该为了列一遍目录就整张拉下来。
   */
  function fileEntryIcon(entry) {
    const icon = document.createElement("span");
    icon.className = "file-entry-icon";
    if (entry.dir) {
      icon.innerHTML = ICONS.folder;
      return icon;
    }
    if (entry.image && Number(entry.size) <= DIR_THUMB_MAX_BYTES) {
      const img = document.createElement("img");
      img.className = "file-entry-thumb";
      img.alt = "";
      img.loading = "lazy";     // 滚到才取：一眼看不到的那些图不先拉下来
      img.decoding = "async";
      img.src = siteUrlOf(entry.path);
      img.addEventListener("error", () => { icon.innerHTML = ICONS.files; });
      icon.appendChild(img);
      return icon;
    }
    icon.innerHTML = ICONS.files;
    return icon;
  }

  /** 清单里给图片挂缩略图的字节上限：更大的照样能点开看，只是清单里仍挂通用图标。 */
  const DIR_THUMB_MAX_BYTES = 2 * 1024 * 1024;

  /**
   * 一份目录清单画进正文：一项一行（名字前一颗图标），点子目录就在这一格里往里走、点文件打开它。
   * 清单里那个相对写法就是下一次请求的路径，跟点消息流里的链接走同一条路
   *（开不开得了由后端那道边界管：指到目录外的条目点了给一句说明）。
   * 待在子目录里时，清单第一行是「上一层」（见 buildFileUpRow）。
   * @param tab 正看着的「目录」那一格（它现在待在哪一层决定要不要「上一层」那一行）
   */
  function renderDirListing(listing, tab) {
    const page = filePage();
    const body = fileSidebar.body;
    if (!page || !body) { return; }
    page.innerHTML = "";
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
      const icon = fileEntryIcon(entry);
      const name = document.createElement("span");
      name.className = "file-entry-name";
      name.textContent = pathLabel(entry.name, entry.dir);
      row.appendChild(icon);
      row.appendChild(name);
      // 子目录就在「目录」这一格里往里走（不新开标签）、文件开一个新标签看
      row.addEventListener("click", () => openSidebarLink(entry.path, 0, !!entry.dir));
      frag.appendChild(row);
    });
    page.appendChild(frag);
    if (listing.truncated) {
      const more = document.createElement("div");
      more.className = "file-note";
      more.textContent = "这个目录里的东西太多，只列出了一部分。";
      page.appendChild(more);
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
    if (isMarkdownPath(tab.path)) { renderFileMarkdown(text, tab.path); return null; }
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

  /** 当网页渲染的扩展名（html 那一族）。 */
  const HTML_PAGE_EXT = new Set(["html", "htm", "xhtml"]);
  /** 这个文件是不是一张网页：是就摆一个 iframe 把它当网页渲染出来（见 renderFileHtml）。 */
  function isHtmlPath(path) { return HTML_PAGE_EXT.has(lastExt(path)); }

  /**
   * 把文件画出来的那一路（见 drawFileResponse）：markdown 排好版渲染成文档，正文里的图片
   * 按这个文件所在的那一层算路径（`docs/a.md` 里的 `img/x.png` 指 `docs/img/x.png`）。
   * 文档不留行号，所以链接里带的行号（`:12`）等于没带，也不报错。
   * 文档里的文件链接由文件侧边栏那段代点（见 buildFileSidebar），照旧开在这一列里。
   */
  function renderFileMarkdown(text, path) {
    const page = filePage();
    if (!page) { return; }
    page.innerHTML = "";
    const doc = document.createElement("div");
    doc.className = "md file-md";
    doc.innerHTML = renderMarkdown(String(text));
    fixMdImages(doc, activeId, dirOfPath(path));
    decorateMermaid(doc);
    page.appendChild(doc);
  }

  /** 一个相对写法里上一层目录怎么写（`docs/a.md` → `docs`，`a.md` → 空串）。 */
  function dirOfPath(path) {
    const i = String(path).lastIndexOf("/");
    return i < 0 ? "" : String(path).slice(0, i);
  }

  /**
   * 把一个文件画出来：一行一格、带行号，hitLine 那一行点亮（0 = 不点亮）。
   * 本仓库认得的那几种语言按扩展名上色（见 highlightFileLines），其余黑白。
   * 只画，不管滚到哪儿（那是 scrollFileBody 的事）：返回点亮的那一行，没点亮就是 null。
   * @param text 文件全文（后端按 UTF-8 给回来的）
   * @param path 这个文件叫什么名字（按扩展名上色用）
   */
  function renderFileText(text, hitLine, path) {
    const page = filePage();
    if (!page) { return null; }
    page.innerHTML = "";
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
    page.appendChild(frag);
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
   * 「目录」那一格走 `/dir`；两条都是只读的、边界也同一套（见后端）。
   */
  function sidebarUrl(tab, mtime) {
    const base = (tab.proj ? "/dir?" : "/file?") + "session=" + encodeURIComponent(activeId || "")
        + "&path=" + encodeURIComponent(tab.path);
    return mtime ? base + "&mtime=" + encodeURIComponent(mtime) : base;
  }

  /**
   * 一个文件当网页渲染时的那条地址：`/site/<会话>/<相对路径>`。
   * 路径摆进地址里是为了页面里的相对引用（`./a.css`、`img/x.png`）由浏览器自己接着解析，
   * 那些子请求也落在同一条地址下面；跟 `/file` 那条一样只读、只认会话目录里的东西。
   */
  function siteUrl(tab) { return siteUrlOf(tab.path); }
  function siteUrlOf(path) {
    const segs = String(path || "").split("/").map(encodeURIComponent).join("/");
    return "/site/" + encodeURIComponent(activeId || "") + "/" + segs;
  }

  /**
   * 把一张网页渲染出来：这一列里摆一个 iframe，直接吃后端那条 `/site/` 地址。
   *
   * 脚本是**真跑**的（sandbox 里给了 allow-scripts + allow-same-origin）：会话目录里的页面
   * 多半靠脚本画图表、读数据，不跑就只剩个空壳。代价是它跟这个页面同源——里头的脚本能读
   * 会话、能替你发消息（这里不把它当隔离；那道 sandbox 只顺手挡掉“把整页跳走 / 弹窗糊住界面”）。
   *
   * @param force 这个文件改过了、要重载一遍：同一个地址浏览器不会自己重新取
   */
  function renderFileHtml(tab, force) {
    const page = filePage();
    if (!page) { return; }
    const src = siteUrl(tab);
    const old = force ? null : page.querySelector("iframe.file-site");
    if (old && old.getAttribute("src") === src) { return; }
    page.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "file-site";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads");
    frame.setAttribute("title", fileSidebarTabName(tab.path));
    frame.src = src;
    page.appendChild(frame);
  }

  /**
   * 问一下这张网页的修改时间（只要头、不要正文），记进标签里：跟着刷新那轮拿它比，
   * 改过了才重载那个 iframe。问不到就算了（iframe 自己会把后端那句人话显示出来）。
   */
  function probeFileMtime(tab) {
    const token = fileSidebar.token;
    fetch(siteUrl(tab), { method: "HEAD", cache: "no-store" }).then((resp) => {
      if (token !== fileSidebar.token) { return; }
      tab.mtime = resp.headers.get("X-File-Mtime") || "";
    }).catch(() => { /* 没连上：留空，下一轮再问 */ });
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
    if (!tab.proj && isHtmlPath(tab.path)) {
      // 网页：内容由浏览器自己按 `/site/` 那条地址去取，不走下面这个 fetch
      //（链接里带的行号在这条路上等于没带：网页里没有“第 42 行”可停）
      tab.loading = false;
      releaseTabImage(tab);
      probeFileMtime(tab);
      renderFileHtml(tab, true);
      tab.drawn = true;
      return;
    }
    tab.loading = true;
    fetch(sidebarUrl(tab, "")).then(async (resp) => {
      tab.loading = false;
      if (token !== fileSidebar.token) { return; }   // 已经换成别的标签了，这条回应丢掉
      tab.mtime = resp.headers.get("X-File-Mtime") || "";   // 看不了时也记：跟着刷新那轮靠它省重传
      if (resp.status !== 200) {
        await showFileRefusal(resp, tab);
        tab.drawn = true;   // 看不了也是一句“看不了”（切回来不必再问一次）
        return;
      }
      if (tab.proj) {
        renderDirListing(await resp.json(), tab);
        tab.drawn = true;
        return;
      }
      scrollFileBody(await drawFileResponse(resp, tab), linkLine, tab.scrollTop);
      tab.drawn = true;
    }).catch(() => {
      tab.loading = false;
      if (token !== fileSidebar.token) { return; }
      // 没连上：不算画过，切回来再试一次
      showFileNote("读不出来：连不上后端。");
    });
  }

  // ==================== 「改动」那一格：这个会话改过哪些文件 ====================
  // 这个会话改过的东西都在这一格看：一行一个文件（本会话第一次改它之前 → 现在磁盘上的），
  // 点一行展开这一块的 diff，块头右边那颗「回滚」把这一个文件整份撤回去。
  // 数据全在后端会话的内存里，刷新页面重问一次就有（插件重启 / 会话关掉就没了，
  // 见 src/editTracker.ts 的 fileBaselines）。

  /** 问清单的地址：这个会话改过哪些文件（相对写法 + 增删行数）。 */
  function changesUrl() {
    return "/changes?session=" + encodeURIComponent(activeId || "");
  }

  /** 问一段 diff 的地址：一个文件本会话的合计 diff。 */
  function changeDiffUrl(path) {
    return "/changes/diff?session=" + encodeURIComponent(activeId || "") + "&path=" + encodeURIComponent(path);
  }

  /**
   * 去后端要一份清单画上。手上已经画过的那一份先留着（页面不闪白），回来的新清单再顶掉它；
   * 哪个文件的增删行数变了，它那段 diff 就作废（下次展开时重取），没变的一直留着。
   */
  function fetchChanges(tab) {
    const token = ++fileSidebar.token;
    tab.loading = true;
    fetch(changesUrl()).then(async (resp) => {
      if (token !== fileSidebar.token) { return; }   // 换了标签 / 切了会话 / 收起：这条回应丢掉
      tab.loading = false;
      if (resp.status !== 200) {
        // 真看不了（会话不在了之类）：没画过就把后端那句话摆上；画过的留着旧的那一份
        if (!tab.drawn) { showFileNote(await readDeadResponse(resp)); }
        return;
      }
      const data = await resp.json().catch(() => null);
      if (token !== fileSidebar.token) { return; }
      const list = data && Array.isArray(data.changes) ? data.changes : [];
      // 这一份跟前一份比：没变的文件手上那段 diff 还作数（展开了不必又去取一次）
      const oldSig = new Map(tab.changes.map((it) => [it.path, changeSignature(it)]));
      list.forEach((it) => {
        if (oldSig.get(it.path) !== changeSignature(it)) { tab.diffs.delete(it.path); }
      });
      // 已经不在这份清单里的路径：攒着的 diff 与「展开着」都清掉（改回去又改回来时不该自己弹开）
      const alive = new Set(list.map((it) => (it && it.path) || ""));
      Array.from(tab.diffs.keys()).forEach((p) => { if (!alive.has(p)) { tab.diffs.delete(p); } });
      Array.from(tab.open).forEach((p) => { if (!alive.has(p)) { tab.open.delete(p); } });
      tab.changes = list;
      drawChanges(tab);
    }).catch(() => {
      tab.loading = false;
      if (token !== fileSidebar.token) { return; }
      if (!tab.drawn) { showFileNote("读不出来：连不上后端。"); }
    });
  }

  /** 清单里一个文件的「这份 diff 还作不作数」：增删行数与删没删掉都没变就不必重取。 */
  function changeSignature(item) {
    if (!item) { return ""; }
    if (item.tooBig) { return "big"; }
    return (item.deleted ? "gone:" : "") + (Number(item.added) || 0) + ":" + (Number(item.removed) || 0);
  }

  /** 后端回的「看不了」那句话；连正文都读不出来就给一句兜底。 */
  async function readDeadResponse(resp) {
    try {
      const text = await resp.text();
      return text || "读不出来。";
    } catch (e) {
      return "读不出来。";
    }
  }

  /**
   * 把清单画到这一格里：一行一个文件。展开着的那几块、读到哪儿都照原样留着
   *（来一条新改动就重画一遍，不能让人正在看的那一块跳走）。
   */
  function drawChanges(tab) {
    const page = fileTabPage(tab);
    if (!page || !fileSidebar.body) { return; }
    cancelChangeRevert();   // 重画就不是刚才那一行了：正等第二下的那一下作废
    const showing = fileSidebar.tabs[fileSidebar.active] === tab;
    const top = showing ? fileSidebar.body.scrollTop : tab.scrollTop;
    page.innerHTML = "";
    if (tab.changes.length === 0) {
      const note = document.createElement("div");
      note.className = "file-note";
      note.textContent = FILE_SIDEBAR_CHANGES_HINT;
      page.appendChild(note);
      tab.drawn = true;
      tab.scrollTop = 0;
      if (showing) { fileSidebar.body.scrollTop = 0; }
      return;
    }
    tab.changes.forEach((item) => { if (item && item.path) { page.appendChild(changeBlock(tab, item)); } });
    tab.drawn = true;
    tab.scrollTop = top;
    if (showing) { fileSidebar.body.scrollTop = top; }
  }

  const CHANGE_REVERT_TEXT = "回滚";
  const CHANGE_REVERT_TITLE = "把这个文件撤回到这个会话第一次改它之前（整份，不是只撤一次调用）";
  /**
   * 「改动」那一格里点过「回滚」、正等第二下确认的那一个文件：再点一下才真回滚
   *（跟关会话那颗叉一个规矩：第一下只把按钮换成确认的样子，几秒不动就自己收回去）。
   */
  let changeRevertPending = null;   // { path, btn, timer }

  /** 把「等第二下确认」的那一颗收回去（超时、这一格重画都走它）：只抹状态，不碰清单。 */
  function cancelChangeRevert() {
    if (!changeRevertPending) { return; }
    const { btn, timer } = changeRevertPending;
    changeRevertPending = null;
    if (timer) { clearTimeout(timer); }
    if (btn && btn.isConnected) {
      btn.classList.remove("confirm");
      btn.textContent = CHANGE_REVERT_TEXT;
      btn.title = CHANGE_REVERT_TITLE;
    }
  }

  /**
   * 点「回滚」：第一下只把这一颗按钮换成确认的样子（几秒后自己收回），再点一下才真回滚——
   * 不再往消息流里塞一张确认卡片（那儿会挡住正在看的消息）。
   */
  function askRevertChange(path, btn) {
    if (changeRevertPending && changeRevertPending.path === path && changeRevertPending.btn === btn) {
      cancelChangeRevert();
      vscode.postMessage({ type: "revertFileChanges", sessionId: activeId, path });
      return;
    }
    cancelChangeRevert();
    btn.classList.add("confirm");
    btn.textContent = "确定回滚";
    btn.title = "再点一下就撤回去（几秒不动就取消）";
    const timer = setTimeout(cancelChangeRevert, 4000);
    changeRevertPending = { path, btn, timer };
  }

  /**
   * 清单里的一行：头一行是相对写法 + 多了几行少了几行（删掉的写「已删除」）+「回滚」，
   * 下面那一块是它的 diff（收着的时候只是藏着，展开过就留着，不必重取）。
   */
  function changeBlock(tab, item) {
    const open = tab.open.has(item.path);
    const block = document.createElement("div");
    block.className = "change-item" + (open ? " open" : "");
    block.setAttribute("data-path", item.path);
    const head = document.createElement("div");
    head.className = "change-head";
    head.title = item.path;   // 一行放不下时悬停看全
    // 太大的文件没有 diff 可展开（后端不比）：那一行就不摆三角、点也不开
    if (!item.tooBig) {
      const arrow = document.createElement("span");
      arrow.className = "change-arrow";
      head.appendChild(arrow);
    }
    const name = document.createElement("span");
    name.className = "change-path";
    name.textContent = item.path;
    head.appendChild(name);
    const counts = document.createElement("span");
    counts.className = "change-counts";
    if (item.tooBig) {
      counts.textContent = "太大，看不了";
    } else {
      if (item.deleted) {
        const gone = document.createElement("span");
        gone.className = "change-flag";
        gone.textContent = "已删除";
        counts.appendChild(gone);
      }
      const add = document.createElement("span");
      add.className = "change-add";
      add.textContent = "+" + (Number(item.added) || 0);
      const del = document.createElement("span");
      del.className = "change-del";
      del.textContent = "−" + (Number(item.removed) || 0);
      counts.appendChild(add);
      counts.appendChild(del);
    }
    head.appendChild(counts);
    const revert = document.createElement("button");
    revert.type = "button";
    revert.className = "change-revert";
    revert.textContent = CHANGE_REVERT_TEXT;
    revert.title = CHANGE_REVERT_TITLE;
    revert.addEventListener("click", (e) => {
      e.stopPropagation();   // 别顺带把这一块展开 / 收起
      askRevertChange(item.path, revert);
    });
    head.appendChild(revert);
    if (!item.tooBig) { head.addEventListener("click", () => toggleChangeBlock(tab, item.path)); }
    block.appendChild(head);
    if (item.tooBig) { return block; }   // 这一行只有「回滚」，没有可展开的东西
    const body = document.createElement("div");
    body.className = "change-body";
    body.hidden = !open;
    block.appendChild(body);
    if (open) { fillChangeBody(tab, item.path, body); }
    return block;
  }

  /** 点一行：展开 / 收起这一块的 diff（展开的那一下才去后端取，取过就攒着）。 */
  function toggleChangeBlock(tab, relPath) {
    const open = !tab.open.has(relPath);
    if (open) { tab.open.add(relPath); } else { tab.open.delete(relPath); }
    const block = changeBlockEl(tab, relPath);
    if (!block) { return; }
    block.classList.toggle("open", open);
    const body = block.querySelector(".change-body");
    if (body) { body.hidden = !open; }
    if (open) { fillChangeBody(tab, relPath, body); }
  }

  /** 清单里某一个文件那一块（点开 / 填内容时按相对写法找它）。 */
  function changeBlockEl(tab, relPath) {
    const page = fileTabPage(tab);
    if (!page) { return null; }
    for (const el of page.children) {
      if (el.getAttribute("data-path") === relPath) { return el; }
    }
    return null;
  }

  /** 把这一块的 diff 填进去：取过就用攒着的，没取过就问后端（一个文件只问一次）。 */
  function fillChangeBody(tab, relPath, body) {
    if (!body) { return; }
    if (body.getAttribute("data-filled") === "1" || body.getAttribute("data-filled") === "loading") { return; }
    const cached = tab.diffs.get(relPath);
    if (cached) {
      body.innerHTML = "";
      body.appendChild(renderDiffBlock(null, cached, ""));
      body.setAttribute("data-filled", "1");
      return;
    }
    body.setAttribute("data-filled", "loading");
    body.innerHTML = "";
    const note = document.createElement("div");
    note.className = "file-note";
    note.textContent = "正在读取…";
    body.appendChild(note);
    fetch(changeDiffUrl(relPath)).then(async (resp) => {
      if (fileSidebar.tabs.indexOf(tab) < 0) { return; }   // 切了会话、这一格没了：丢掉
      const text = await readDeadResponse(resp);
      body.innerHTML = "";
      body.setAttribute("data-filled", "1");
      if (resp.status !== 200) {
        const bad = document.createElement("div");
        bad.className = "file-note";
        bad.textContent = text;
        body.appendChild(bad);
        return;
      }
      tab.diffs.set(relPath, text);
      body.appendChild(renderDiffBlock(null, text, ""));
    }).catch(() => {
      body.innerHTML = "";
      body.removeAttribute("data-filled");   // 没连上：下次展开再试
      const bad = document.createElement("div");
      bad.className = "file-note";
      bad.textContent = "读不出来：连不上后端。";
      body.appendChild(bad);
    });
  }

  /** 后端说「改动变了」：正看着那一格就重问一遍清单（没看着不必忙，摆上时会自己重问）。 */
  function refreshChangesTab() {
    const at = fileSidebarChangesIndex();
    const tab = at >= 0 ? fileSidebar.tabs[at] : null;
    if (!tab || fileSidebar.tabs[fileSidebar.active] !== tab) { return; }
    fetchChanges(tab);
  }

  // ==================== 「后台」那一格：放到后台跑的命令 ====================
  // 这个会话里被放到后台的命令都在这一格：一行一条（编号、跑到哪一步、用时、命令），
  // 点一行看它最后一段输出；还在跑的那条右边有一颗「停」。
  // 数据在后端会话的内存里（见 src/sessionRuntime.ts 的 bashTasks）：刷新页面重问一次就有，
  // 插件重启 / 会话关掉就没了（日志文件还在磁盘上）。
  // 怎么让一条正在跑的命令转到后台：消息流里「正在跑的那一条」上那颗「放后台」。

  /** 问清单的地址：这个会话有哪些放到后台跑的命令。 */
  function scriptsUrl() {
    return "/bash?session=" + encodeURIComponent(activeId || "");
  }

  /** 问一条后台命令输出的地址（展开那一行时才取）。 */
  function scriptLogUrl(no) {
    return "/bash/log?session=" + encodeURIComponent(activeId || "") + "&no=" + encodeURIComponent(String(no));
  }

  /** 去后端要一份清单画上（跟「改动」一个做法：手上那份先留着，回来的顶掉它）。 */
  function fetchScripts(tab) {
    const token = ++fileSidebar.token;
    tab.loading = true;
    fetch(scriptsUrl()).then(async (resp) => {
      if (token !== fileSidebar.token) { return; }   // 换了标签 / 切了会话 / 收起：这条回应丢掉
      tab.loading = false;
      if (resp.status !== 200) {
        if (!tab.drawn) { showFileNote(await readDeadResponse(resp)); }
        return;
      }
      const data = await resp.json().catch(() => null);
      if (token !== fileSidebar.token) { return; }
      const list = data && Array.isArray(data.tasks) ? data.tasks : [];
      // 已经不在这份清单里的：攒着的输出与「展开着」都清掉
      const alive = new Set(list.map((it) => String((it && it.no) || "")));
      Array.from(tab.logs.keys()).forEach((k) => { if (!alive.has(String(k))) { tab.logs.delete(k); } });
      Array.from(tab.open).forEach((k) => { if (!alive.has(String(k))) { tab.open.delete(k); } });
      tab.scripts = list;
      drawScripts(tab);
    }).catch(() => {
      tab.loading = false;
      if (token !== fileSidebar.token) { return; }
      if (!tab.drawn) { showFileNote("读不出来：连不上后端。"); }
    });
  }

  /** 把清单画到这一格里：一行一条命令。展开着的那几行、读到哪儿都照原样留着。 */
  function drawScripts(tab) {
    const page = fileTabPage(tab);
    if (!page || !fileSidebar.body) { return; }
    const showing = fileSidebar.tabs[fileSidebar.active] === tab;
    const top = showing ? fileSidebar.body.scrollTop : tab.scrollTop;
    page.innerHTML = "";
    if (tab.scripts.length === 0) {
      const note = document.createElement("div");
      note.className = "file-note";
      note.textContent = FILE_SIDEBAR_SCRIPTS_HINT;
      page.appendChild(note);
      tab.drawn = true;
      tab.scrollTop = 0;
      if (showing) { fileSidebar.body.scrollTop = 0; }
      return;
    }
    tab.scripts.forEach((task) => { if (task) { page.appendChild(scriptRow(tab, task)); } });
    tab.drawn = true;
    tab.scrollTop = top;
    if (showing) { fileSidebar.body.scrollTop = top; }
    syncScriptsClock(tab);
  }

  /** 「后台」那一格那个计时：有还在跑的命令时，每半秒把那一行的用时改一下（不重画清单）。 */
  let scriptsClock = 0;
  function syncScriptsClock(tab) {
    const hasRunning = !!tab && tab.scripts.some((t) => t && t.status === "running");
    if (!hasRunning) { stopScriptsClock(); return; }
    if (scriptsClock) { return; }
    scriptsClock = setInterval(() => {
      const at = fileSidebarScriptsIndex();
      const cur = at >= 0 ? fileSidebar.tabs[at] : null;
      const page = cur ? fileTabPage(cur) : null;
      // 切走了 / 这一格没了：表停掉（切回来时 drawScripts 会重开）
      if (!page || fileSidebar.tabs[fileSidebar.active] !== cur) { stopScriptsClock(); return; }
      for (const el of page.querySelectorAll(".script-item")) {
        const no = el.getAttribute("data-no");
        const task = cur.scripts.find((x) => x && String(x.no) === no);
        if (!task || task.status !== "running") { continue; }
        const time = el.querySelector(".script-time");
        const since = Number(task.startedAt) || 0;
        if (time && since) { time.textContent = formatElapsed(Date.now() - since); }
      }
    }, 500);
  }
  function stopScriptsClock() {
    if (!scriptsClock) { return; }
    clearInterval(scriptsClock);
    scriptsClock = 0;
  }

  /** 一条后台命令跑到哪一步了（界面上的说法）。 */
  function scriptStatusText(task) {
    if (task.status === "running") { return "在跑"; }
    if (task.status === "stopped") { return "已停掉"; }
    if (task.status === "failed") {
      return task.exitCode === null || task.exitCode === undefined ? "没跑成" : "没跑成（退出码 " + task.exitCode + "）";
    }
    return "跑完了";
  }

  /**
   * 清单里的一行：#编号 + 跑到哪一步 + 用时（还在跑的写「已经跑了多少」），
   * 下面一行是命令（一行放不下时悬停看全），点一下展开这条命令的最后一段输出。
   */
  function scriptRow(tab, task) {
    const key = String(task.no);
    const open = tab.open.has(key);
    const running = task.status === "running";
    const block = document.createElement("div");
    block.className = "script-item" + (open ? " open" : "");
    block.setAttribute("data-no", key);
    const head = document.createElement("div");
    head.className = "script-head";
    const arrow = document.createElement("span");
    arrow.className = "change-arrow";
    head.appendChild(arrow);
    const no = document.createElement("span");
    no.className = "script-no";
    no.textContent = "#" + task.no;
    head.appendChild(no);
    const state = document.createElement("span");
    state.className = "script-state" + (running ? " running" : task.status === "failed" ? " failed" : "");
    state.textContent = scriptStatusText(task);
    head.appendChild(state);
    const time = document.createElement("span");
    time.className = "script-time";
    const since = Number(task.startedAt) || 0;
    const used = running ? Date.now() - since : (Number(task.elapsedMs) || (since ? Date.now() - since : 0));
    time.textContent = used > 0 ? formatElapsed(used) : "";
    head.appendChild(time);
    if (running) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "script-stop";
      stop.textContent = "停";
      stop.title = "把这条命令连它派出来的进程一起停掉";
      stop.addEventListener("click", (e) => {
        e.stopPropagation();   // 别顺带把这一行展开 / 收起
        stop.disabled = true;  // 等后端推送回来再按真实状态画
        vscode.postMessage({ type: "bashStop", sessionId: activeId, no: task.no });
      });
      head.appendChild(stop);
    }
    head.addEventListener("click", () => toggleScriptRow(tab, key));
    block.appendChild(head);
    const cmd = document.createElement("div");
    cmd.className = "script-cmd";
    cmd.textContent = task.cmd || "";
    cmd.title = task.cmd || "";
    block.appendChild(cmd);
    const body = document.createElement("div");
    body.className = "script-body";
    body.hidden = !open;
    block.appendChild(body);
    if (open) { fillScriptLog(tab, key, body); }
    return block;
  }

  /** 点一行：展开 / 收起这条命令的输出（展开的那一下才去后端取，取过就攒着）。 */
  function toggleScriptRow(tab, key) {
    const open = !tab.open.has(key);
    if (open) { tab.open.add(key); } else { tab.open.delete(key); }
    const page = fileTabPage(tab);
    if (!page) { return; }
    for (const el of page.children) {
      if (el.getAttribute("data-no") !== key) { continue; }
      el.classList.toggle("open", open);
      const body = el.querySelector(".script-body");
      if (body) { body.hidden = !open; }
      if (open) { fillScriptLog(tab, key, body); }
      return;
    }
  }

  /**
   * 日志文件开头那两行是文件自己写的「$ 命令」加一个空行（见 src/bashBridgeSource.ts）；
   * 而这一行上面已经写着同一条命令了，画输出的时候把这两行掐掉，别让一条命令并排出现两遍。
   * 掐的是跟这条命令一模一样的那一行：命令自己带了空行也不会多掐。
   */
  function scriptLogText(text, cmd) {
    const all = String(text || "");
    const head = "$ " + String(cmd || "") + "\n\n";
    return cmd && all.startsWith(head) ? all.slice(head.length) : all;
  }

  /** 把这条命令的输出填进去：取过就用攒着的，没取过就问后端（一条只问一次）。 */
  function fillScriptLog(tab, key, body) {
    if (!body) { return; }
    if (body.getAttribute("data-filled") === "1" || body.getAttribute("data-filled") === "loading") { return; }
    const cached = tab.logs.get(key);
    if (cached !== undefined) {
      body.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "script-log";
      pre.textContent = cached || "（还没有输出）";
      body.appendChild(pre);
      body.setAttribute("data-filled", "1");
      return;
    }
    body.setAttribute("data-filled", "loading");
    body.innerHTML = "";
    const note = document.createElement("div");
    note.className = "file-note";
    note.textContent = "正在读取…";
    body.appendChild(note);
    fetch(scriptLogUrl(key)).then(async (resp) => {
      if (fileSidebar.tabs.indexOf(tab) < 0) { return; }   // 切了会话、这一格没了：丢掉
      const text = await readDeadResponse(resp);
      body.innerHTML = "";
      body.setAttribute("data-filled", "1");
      if (resp.status !== 200) {
        const bad = document.createElement("div");
        bad.className = "file-note";
        bad.textContent = text;
        body.appendChild(bad);
        return;
      }
      const out = scriptLogText(text, (tab.scripts.find((it) => it && String(it.no) === String(key)) || {}).cmd);
      tab.logs.set(key, out);
      const pre = document.createElement("pre");
      pre.className = "script-log";
      pre.textContent = out || "（还没有输出）";
      body.appendChild(pre);
    }).catch(() => {
      body.innerHTML = "";
      body.removeAttribute("data-filled");   // 没连上：下次展开再试
      const bad = document.createElement("div");
      bad.className = "file-note";
      bad.textContent = "读不出来：连不上后端。";
      body.appendChild(bad);
    });
  }

  /**
   * 后端说某条后台命令有动静了（转到后台 / 跑完 / 被停）：更新清单里那一条。
   * 正看着「后台」那一格才重画；没看着的话摆上时会自己重问一遍。
   */
  function applyBashTask(task) {
    if (!task) { return; }
    const at = fileSidebarScriptsIndex();
    const tab = at >= 0 ? fileSidebar.tabs[at] : null;
    if (!tab) { return; }
    const list = tab.scripts.slice();
    const i = list.findIndex((it) => it && Number(it.no) === Number(task.no));
    if (i >= 0) { list[i] = task; } else { list.unshift(task); }
    list.sort((a, b) => (Number(b && b.no) || 0) - (Number(a && a.no) || 0));
    tab.scripts = list;
    // 跑完的那一条：攒着的输出作废（下次展开重新取，看得到结尾那几行）
    if (task.status !== "running") { tab.logs.delete(String(task.no)); }
    if (fileSidebar.tabs[fileSidebar.active] === tab) { drawScripts(tab); }
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
    if (tab.change) { return; }   // 「改动」那一格也不跟着刷新：模板变了由 changesChanged 叫它（见那条消息）
    if (tab.scriptsTab) { return; }   // 「后台」那一格同样不跟着刷新：后台命令有动静由 bashTask 叫它
    if (isHtmlPath(tab.path)) { pollHtmlFile(tab, at); return; }   // 网页：只问修改时间，改过才重载
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

  /**
   * 跟着刷新那一轮里的网页：只问修改时间（HEAD），改过了才把那个 iframe 重载一遍。
   * 重载会把页面里的状态（滚动、输入、跑着的脚本）清掉，所以只有真改过才做。
   */
  function pollHtmlFile(tab, at) {
    if (filePolling) { return; }
    const token = fileSidebar.token;
    filePolling = true;
    fetch(siteUrl(tab), { method: "HEAD", cache: "no-store" }).then(async (resp) => {
      if (token !== fileSidebar.token || fileSidebar.active !== at) { return; }   // 换了标签 / 切了会话 / 收起
      if (resp.status !== 200) { await showFileRefusal(resp, tab); return; }
      const mtime = resp.headers.get("X-File-Mtime") || "";
      if (mtime && mtime === tab.mtime) { return; }   // 没变：一个字都不动
      tab.mtime = mtime;
      renderFileHtml(tab, true);
    }).catch(() => {
      // 这一轮没连上就算了：页面留着，下一轮再问
    }).then(() => { filePolling = false; });
  }

  /** 窄窗里只留一块侧边栏：右边那块此刻露着就收起来（两块都常驻时不动它）。 */
  function closeRightSidebarForFile() {
    if (fileSidebarWide()) { return; }
    const st = modalView.state;
    if (st && st.kind === "workspace" && !modalView.root.classList.contains("hidden")) { cancelPicker(modalView); return; }
    if (sidebarEnabled()) { collapseSidebar(); }
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
      ensureProjectDirTab();   // 空着的时候先把「目录」那一格摆上（会话目录还没认识就留那句提示）
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
   * 点一条链接（消息流里的文件 / 目录链接，或者清单上的一项）：目录去「目录」那一格里走
   *（不占标签），文件开一个自己的标签看。
   * @param dir 这是个目录（消息流那边看 `data-dir`，清单那边看 `entry.dir`）
   */
  function openSidebarLink(path, line, dir) {
    if (dir) { openDirInProjectTab(path); return; }
    openFileInSidebar(path, line);
  }

  /**
   * 点链接、进目录之前的张罗：窄窗里把右边那块让开，把「目录」那一格摆到第一格
   *（还没有就摆上；会话目录还不认识时它会留一句提示），再把这一列开出来。
   */
  function prepareFileSidebar() {
    closeRightSidebarForFile();
    addProjectDirTab();   // 第一格留给「文件」（只摆不取，排在前面）
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
    const at = fileSidebarProjectIndex();
    const tab = at >= 0 ? fileSidebar.tabs[at] : null;
    if (!tab) { return; }
    if (tab.proj) {
      tab.dir = tab.path;   // 从清单点进去：记住这一层，关掉文件时回到这儿
    } else {
      // 已经在看另一个文件：那一块正文扔掉（里面画的是上一个文件）
      dropFileTabPage(tab);
    }
    tab.proj = false;
    tab.path = path;
    tab.line = Number(line) > 0 ? Number(line) : 0;
    tab.mtime = "";
    tab.loading = false;
    tab.scrollTop = 0;
    tab.drawn = false;
    releaseTabImage(tab);
    showFileTab(at, line);
  }

  /** 「文件」那一格顶上那颗关闭：手头这个文件收起不看，回到刚才那一层目录。 */
  function backToFileList() {
    const at = fileSidebarProjectIndex();
    const tab = at >= 0 ? fileSidebar.tabs[at] : null;
    if (!tab || tab.proj) { return; }
    dropFileTabPage(tab);
    tab.proj = true;
    tab.path = tab.dir || FILE_SIDEBAR_PROJECT_PATH;
    tab.line = 0;
    tab.mtime = "";
    tab.loading = false;
    tab.scrollTop = 0;
    tab.drawn = false;
    releaseTabImage(tab);
    showFileTab(at, 0);
  }

  /**
   * 点一个目录：在「目录」那一格里走（目录不占标签）——切到那一格、换成这一层重新列出来；
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
    const tab = fileSidebar.tabs[at];
    if (!tab.proj) {
      // 正在看文件：那块正文扔掉，回到清单模式（下面按新的一层重新列）
      dropFileTabPage(tab);
      releaseTabImage(tab);
      tab.proj = true;
    }
    tab.path = key;
    tab.dir = key;
    tab.line = 0;
    tab.drawn = false;   // 换了一层：这一块里画的是上一层那份清单，作废（下面重新取）
    showFileTab(at, 0);
  }

  /** 上一层目录的相对写法（`dirA/sub` → `dirA`；`dirA` → `.`，就是会话目录本身）。 */
  function parentDirPath(path) {
    const parts = String(path || "").split("/").filter((x) => x.length > 0);
    parts.pop();
    return parts.length > 0 ? parts.join("/") : FILE_SIDEBAR_PROJECT_PATH;
  }

  /**
   * 点清单第一行那颗「上一层」：「目录」那一格退到上一层，还是这一格那份清单
   *（到会话目录本身那一层就退不动了，那一行也不出现，见 buildFileUpRow）。
   */
  function goUpProjectDir() {
    const at = fileSidebarProjectIndex();
    const tab = at >= 0 ? fileSidebar.tabs[at] : null;
    if (!tab || tab.proj !== true || tab.path === FILE_SIDEBAR_PROJECT_PATH) { return; }
    tab.path = parentDirPath(tab.path);
    tab.dir = tab.path;
    tab.drawn = false;   // 换了一层：那一块里是原来那一层的清单，作废（下面重新取）
    showFileTab(at, 0);
  }

  /**
   * 点一个文件的时候去哪儿：浏览器页面里开左边这一列看（后端自己读），插件里的对话面板里
   * 照旧交给编辑器打开。正文里的文件链接与工具卡片那颗「跳转」都走这里，别各写一遍。
   *
   * 先问后端一句「这个名字对上了几个文件」：一个就直接开；同名的不止一个就把搜索浮层
   * 弹出来、预填这个名字，让点的人自己挑（挑中的还停在链接说的那一行）。
   * @param dir 这是个目录（只有正文里以斜杠结尾的写法会带；工具卡片那颗按钮没有这种）
   */
  function openFileForUser(path, line, col, dir) {
    if (!path) { return; }
    if (dir) { openFileDirect(path, line, col, dir); return; }
    const requestId = ++fileCandidatesSeq;
    // 后端没回话（版本对不上、断线）：照老样子直接开，别让点一下没反应。
    // 等得比后端自己那两道时限都长（无 ripgrep 时走目录 4 秒、有 rg 时 10 秒）：
    // 大仓库里先放弃的话，会赶在真话之前按写的那样硬开，结果是「看不了」。
    const timer = setTimeout(() => {
      if (!pendingFileCandidates.has(requestId)) { return; }
      pendingFileCandidates.delete(requestId);
      openFileDirect(path, line, col);
    }, FILE_CANDIDATES_WAIT_MS);
    pendingFileCandidates.set(requestId, { path: path, line: line, col: col, timer: timer });
    vscode.postMessage({ type: "pathCandidates", path: path, requestId: requestId });
  }

  /** 后端回了「这个名字对上了哪几个文件」：一个就开，好几个就弹搜索浮层。 */
  function onPathCandidates(msg) {
    const pend = pendingFileCandidates.get(msg.requestId);
    if (!pend) { return; }
    pendingFileCandidates.delete(msg.requestId);
    clearTimeout(pend.timer);
    const list = Array.isArray(msg.candidates)
      ? msg.candidates.filter((x) => typeof x === "string" && x !== "") : [];
    if (list.length > 1) {
      const name = String(pend.path).replace(/\\/g, "/").split("/").pop() || String(pend.path);
      openFileSearch({
        query: name,
        line: pend.line || 0,
        hint: "「" + pend.path + "」对上了 " + list.length + " 个同名文件，点一个打开。",
      });
      return;
    }
    openFileDirect(list.length === 1 ? list[0] : pend.path, pend.line, pend.col);
  }

  /** 真去开一个文件（不再问同名的事了）。 */
  function openFileDirect(path, line, col, dir) {
    if (!path) { return; }
    if (fileSidebar.root) { openSidebarLink(path, line, dir); return; }
    vscode.postMessage({ type: "openFile", path, line, col });
  }

  let fileCandidatesSeq = 0;
  /** 正在等后端回话的那几次点链接（键是 requestId）。 */
  const pendingFileCandidates = new Map();

  /**
   * 切会话：手上这一份标签（开着的文件、看的是哪一个）记在它会话名下，
   * 然后把新会话自己那一份摆出来（切回一个会话时，它的标签原样回来、内容重读一次）。
   *
   * 正文那几块不跟着串会话：标签里的路径是相对那个会话目录写的，
   * 所以切走时把它们撤掉（连着网页那个 iframe、图片那个显示地址）。
   */
  function resetFileSidebarForSession() {
    if (!fileSidebar.root) { return; }
    fileSidebar.token++;
    rememberFileTabScroll();
    // 常驻那三格跟着会话走：一次全撤掉重建（文件那一格回到清单——上一个会话的文件不该跟过来）
    fileSidebar.tabs.forEach(dropFileTabPage);
    fileSidebar.tabs = [];
    fileSidebar.active = -1;
    fileSidebar.sessionId = activeId || null;
    renderFileTabs();
    syncFilePages();
    showFileNote(FILE_SIDEBAR_HINT);
    ensureProjectDirTab();   // 开着就换成新会话的目录；收着的那就等打开时再说
  }

  /**
   * 拖右边那条缝改宽度（常驻时能拖，PC 上从左边滑入的那一层也能拖，见 chat.css 的 #fileResize）。
   * 按住之后指针捕获在这一格上，拖到面板外面、拖到窗口边上都不断线。
   * 拖动中只动这一列自己：它是浮在对话上面的（position: fixed），动它不碰版面；
   * 对话那边空出多宽由 body.file-dock::before 那块占位决定，那块先冻着不动——
   * 它一动，整屏消息就得重新排字（长会话一次几十毫秒）。
   * 松手那一下才落到版式上（对话跟着排一次），也是到那一下才记进本机。
   */
  function wireFileSidebarResize(handle) {
    if (!handle) { return; }
    let dragging = false;
    /** 按住的那一点离右边那条线有多远：拖起来那条线不往指针底下跳。 */
    let grabOffset = 0;
    const move = (e) => {
      if (!dragging) { return; }
      const w = clampFileSidebarDragWidth(e.clientX - grabOffset);
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
      if (e.button !== 0 || !fileSidebarResizable()) { return; }   // 手机上铺满整屏那一层不给拖
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
    // 这一列没有单独的头：标签条就在最上面那一行，「收起」那颗叉摆在它右端
    root.innerHTML =
      '<div id="filePanel" class="pk-panel">' +
        '<div id="fileHeader" class="pk-header">' +
          '<div id="fileTabs"></div>' +
          '<button id="fileSearchBtn" type="button" title="文件搜索（Ctrl+Shift+F）" aria-label="文件搜索">' + SEARCH_ICON + '</button>' +
          '<button id="fileClose" class="pk-header-close" type="button" title="收起" aria-label="收起">' + ICONS["close-bold"] + '</button>' +
        '</div>' +
        // 看文件时正文上面那条横条：左边一颗返回（回文件列表），右边写这个文件叫什么。
        // 返回摆在最左边、画成箭头：以前它是一颗叉、钉在右角上，正好跟上面那颗收起整列的叉
        // 上下叠成一列（两者中心只隔 28px），手指一点就点岔 —— 一个收起整列、一个退回清单。
        '<div id="fileBar" hidden>' +
          '<button id="fileCloseFile" type="button" title="关掉这个文件，回到文件列表" aria-label="回到文件列表">'
            + ICONS["arrow-left"] + '</button>' +
          '<span class="file-bar-name"></span>' +
        '</div>' +
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
    fileSidebar.tabsEl = root.querySelector("#fileTabs");
    fileSidebar.body = root.querySelector("#fileBody");
    fileSidebar.open = readFileSidebarWanted();
    fileSidebar.wrap = readFileSidebarWrapWanted();
    fileSidebar.width = readFileSidebarWidthWanted();
    fileSidebar.resize = root.querySelector("#fileResize");
    fileSidebar.bar = root.querySelector("#fileBar");
    fileSidebar.barName = root.querySelector("#fileBar .file-bar-name");
    fileSidebar.closeFile = root.querySelector("#fileCloseFile");
    fileSidebar.closeFile.addEventListener("click", () => backToFileList());
    wireFileSidebarResize(fileSidebar.resize);
    root.querySelector("#fileClose").addEventListener("click", () => setFileSidebarOpen(false));
    root.querySelector("#fileSearchBtn").addEventListener("click", () => openFileSearch());
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
      openFileForUser(path, a.dataset.line ? parseInt(a.dataset.line, 10) : 0, a.getAttribute("data-dir") === "1");
    });
    // 跟着刷新：开着而且有正看着的文件时，隔一会儿问一次（页面在后台时不问：手机上别白耗电）
    setInterval(() => {
      if (!fileSidebar.open || document.hidden) { return; }
      pollActiveFile();
    }, FILE_SIDEBAR_POLL_MS);
    // 顶条左边那颗按钮（由 browserBridge.js 建）点它走这里
    window.pichatFileSidebar = { toggle: toggleFileSidebar };
  })();

  // ==================== 文件搜索（Ctrl+Shift+F）====================
  //
  // 一块浮层：上面输入框，下面一列结果。两档：「文件名」（默认，边打边出）和「内容」
  // （文件里的文字，带行号 + 那一行）。两档都由后端找（消息 findFiles → findResults）：
  // 它拿会话目录的文件清单、优先用 ripgrep；浏览器页面和插件里的对话面板走同一条路。
  //
  // 点一条结果：浏览器页面里在左边那一列打开、停在那一行（跟点正文里的文件链接一样）；
  // 插件里的对话面板里交给编辑器打开（见 openFileForUser）。
  //
  // 手机上没键盘：文件侧边栏头上那颗放大镜也能开它。
  const fileSearch = {
    built: false,
    root: null, input: null, body: null, filesBtn: null, textBtn: null, hintEl: null,
    // 上次用的那一档留着（这次打开接着用）；开没收起不记进设备。
    mode: "files",
    open: false,
    seq: 0,        // 每发一次就加一：只认最后一次的回话
    want: 0,       // 现在等的是哪一次
    timer: 0,      // 打字防抖
    items: [],     // [{ path, line?, text? }]
    sel: -1,
    // 点了一个同名链接弹出来的：打开选中的那个时停在哪一行、头顶那一句说明
    line: 0,
    hint: "",
  };

  /** 浮层只搭一次：第一次按快捷键（或者点放大镜）时建出来，以后就只开关。 */
  function buildFileSearch() {
    if (fileSearch.built) { return; }
    fileSearch.built = true;
    const root = document.createElement("div");
    root.id = "fileSearchOverlay";
    root.className = "hidden";
    root.innerHTML =
      '<div id="fileSearchPanel" role="dialog" aria-label="文件搜索">' +
        '<div id="fileSearchHead">' +
          '<span id="fileSearchTitle">文件搜索</span>' +
          '<div id="fileSearchModes">' +
            '<button id="fsModeFiles" class="fs-mode on" type="button">文件名</button>' +
            '<button id="fsModeText" class="fs-mode" type="button">内容</button>' +
          '</div>' +
          '<button id="fileSearchClose" type="button" title="关闭（Esc）" aria-label="关闭">' + ICONS["close-bold"] + '</button>' +
        '</div>' +
        '<div id="fileSearchInputWrap"><input id="fileSearchInput" type="text" placeholder="搜文件名…" autocomplete="off" spellcheck="false" /></div>' +
        '<div id="fileSearchHint" class="fs-hint hidden"></div>' +
        '<div id="fileSearchBody"></div>' +
      '</div>';
    document.body.appendChild(root);
    fileSearch.root = root;
    fileSearch.input = root.querySelector("#fileSearchInput");
    fileSearch.body = root.querySelector("#fileSearchBody");
    fileSearch.filesBtn = root.querySelector("#fsModeFiles");
    fileSearch.textBtn = root.querySelector("#fsModeText");
    fileSearch.hintEl = root.querySelector("#fileSearchHint");
    root.querySelector("#fileSearchClose").addEventListener("click", () => closeFileSearch());
    root.addEventListener("click", (e) => { if (e.target === root) { closeFileSearch(); } });
    fileSearch.filesBtn.addEventListener("click", () => setFileSearchMode("files"));
    fileSearch.textBtn.addEventListener("click", () => setFileSearchMode("text"));
    fileSearch.input.addEventListener("input", () => {
      // 一开始那句「对上了 N 个同名文件」是上一次点链接说的，一改关键词就不作数了
      if (fileSearch.hint) {
        fileSearch.hint = "";
        renderFileSearchHint();
      }
      scheduleFileSearch();
    });
    fileSearch.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // 先就地把这条 Esc 吃掉：外面 document 上的监听会拿它去中止正在生成的那一轮
        e.preventDefault();
        e.stopImmediatePropagation();
        closeFileSearch();
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); moveFileSearchSel(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveFileSearchSel(-1); return; }
      if (e.key === "Enter") { e.preventDefault(); chooseFileSearchItem(fileSearch.sel); }
    });
    syncFileSearchMode();
  }

  function toggleFileSearch() {
    if (fileSearch.open) { closeFileSearch(); } else { openFileSearch(); }
  }

  function openFileSearch(opts) {
    buildFileSearch();
    fileSearch.open = true;
    fileSearch.root.classList.remove("hidden");
    const prefill = opts && typeof opts.query === "string" ? opts.query : "";
    fileSearch.line = opts && Number(opts.line) > 0 ? Number(opts.line) : 0;
    fileSearch.hint = opts && opts.hint ? String(opts.hint) : "";
    renderFileSearchHint();
    // 点同名链接弹出来的那次一定是找文件（不是搜内容），而且名字已经填好了
    if (prefill) { fileSearch.mode = "files"; }
    syncFileSearchMode();
    fileSearch.input.value = prefill;
    fileSearch.items = [];
    fileSearch.sel = -1;
    renderFileSearchNote("");
    setTimeout(() => {
      if (!fileSearch.open) { return; }
      fileSearch.input.focus();
      // 预填的名字把光标放在最后：再打几个字就是接着缩小范围
      try { fileSearch.input.setSelectionRange(prefill.length, prefill.length); } catch (e) { /* 不管 */ }
    }, 0);
    runFileSearch();
  }

  /** 输入框下面那行说明：只在点同名链接弹出来时有（写对上了几个）。 */
  function renderFileSearchHint() {
    if (!fileSearch.built) { return; }
    fileSearch.hintEl.textContent = fileSearch.hint || "";
    fileSearch.hintEl.classList.toggle("hidden", !fileSearch.hint);
  }

  function closeFileSearch() {
    if (!fileSearch.open) { return; }
    fileSearch.open = false;
    clearTimeout(fileSearch.timer);
    fileSearch.seq += 1;
    fileSearch.want = fileSearch.seq;   // 路上那次回话作废
    if (fileSearch.root) { fileSearch.root.classList.add("hidden"); }
    if (fileSearch.input) { fileSearch.input.blur(); }
  }

  function setFileSearchMode(mode) {
    if (fileSearch.mode === mode) { return; }
    fileSearch.mode = mode;
    syncFileSearchMode();
    runFileSearch();
  }

  function syncFileSearchMode() {
    if (!fileSearch.built) { return; }
    const files = fileSearch.mode === "files";
    fileSearch.filesBtn.classList.toggle("on", files);
    fileSearch.textBtn.classList.toggle("on", !files);
    fileSearch.filesBtn.setAttribute("aria-pressed", files ? "true" : "false");
    fileSearch.textBtn.setAttribute("aria-pressed", files ? "false" : "true");
    fileSearch.input.placeholder = files ? "搜文件名…" : "搜文件里的文字…";
  }

  function scheduleFileSearch() {
    clearTimeout(fileSearch.timer);
    // 内容那一档要起 rg 进程：多等一会儿，别每敲一个字母就起一次
    fileSearch.timer = setTimeout(runFileSearch, fileSearch.mode === "text" ? 220 : 70);
  }

  function runFileSearch() {
    if (!fileSearch.open) { return; }
    clearTimeout(fileSearch.timer);
    const mode = fileSearch.mode;
    const query = fileSearch.input.value;
    fileSearch.seq += 1;
    fileSearch.want = fileSearch.seq;
    if (mode === "text" && !query.trim()) {
      fileSearch.items = [];
      fileSearch.sel = -1;
      renderFileSearchNote("输入要搜的文字。");
      return;
    }
    // 旧结果先留着，新的回来再换：每敲一个字母就闪一下空白不好看
    vscode.postMessage({ type: "findFiles", mode: mode, query: query, seq: fileSearch.seq });
  }

  /** 后端把这一次的结果送回来了（seq 对不上的——前面发的那几次——直接丢掉）。 */
  function onFindResults(msg) {
    if (!fileSearch.open || msg.seq !== fileSearch.want) { return; }
    if (msg.error) {
      fileSearch.items = [];
      fileSearch.sel = -1;
      renderFileSearchNote(String(msg.error));
      return;
    }
    const query = typeof msg.query === "string" ? msg.query : "";
    if (msg.mode === "text") {
      fileSearch.items = (Array.isArray(msg.hits) ? msg.hits : []).map((hit) => ({
        path: String(hit.path || ""), line: Number(hit.line) || 0, text: String(hit.text || ""),
      }));
    } else {
      fileSearch.items = (Array.isArray(msg.files) ? msg.files : []).map((rel) => ({ path: String(rel) }));
    }
    fileSearch.sel = fileSearch.items.length > 0 ? 0 : -1;
    if (fileSearch.items.length === 0) {
      renderFileSearchNote(query.trim() ? "没有找到。" : "输入关键词找文件。");
      return;
    }
    renderFileSearchItems(query, msg.truncated === true);
  }

  function renderFileSearchNote(text) {
    if (!fileSearch.built) { return; }
    fileSearch.body.innerHTML = "";
    if (!text) { return; }
    const note = document.createElement("div");
    note.className = "fs-note";
    note.textContent = text;
    fileSearch.body.appendChild(note);
  }

  function renderFileSearchItems(query, truncated) {
    fileSearch.body.innerHTML = "";
    const frag = document.createDocumentFragment();
    fileSearch.items.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "fs-row" + (idx === fileSearch.sel ? " on" : "");
      if (item.line) {
        // 内容那一档：上面一行是「路径:行号」，下面一行是那一行文字（命中处标出来）
        const head = document.createElement("div");
        head.className = "fs-text-head";
        head.appendChild(markFileSearchHit(item.path + ":" + item.line, query));
        row.appendChild(head);
        const text = document.createElement("div");
        text.className = "fs-text-line";
        text.appendChild(markFileSearchHit(item.text || "", query));
        row.appendChild(text);
      } else {
        // 文件名那一档：目录淡一点，文件名粗一点
        const line = document.createElement("div");
        line.className = "fs-file-line";
        const slash = item.path.lastIndexOf("/");
        if (slash >= 0) {
          const dir = document.createElement("span");
          dir.className = "fs-dir";
          dir.appendChild(markFileSearchHit(item.path.slice(0, slash + 1), query));
          line.appendChild(dir);
        }
        const name = document.createElement("span");
        name.className = "fs-name";
        name.appendChild(markFileSearchHit(item.path.slice(slash + 1), query));
        line.appendChild(name);
        row.appendChild(line);
      }
      row.addEventListener("click", () => chooseFileSearchItem(idx));
      frag.appendChild(row);
    });
    if (truncated) {
      const more = document.createElement("div");
      more.className = "fs-note";
      more.textContent = "只列了一部分，再打几个字缩小范围。";
      frag.appendChild(more);
    }
    fileSearch.body.appendChild(frag);
    scrollFileSearchSel();
  }

  /** 把关键词命中的那几截包成 <mark>（大小写不敏感，不认正则）。 */
  function markFileSearchHit(text, query) {
    const frag = document.createDocumentFragment();
    const whole = String(text || "");
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) {
      frag.appendChild(document.createTextNode(whole));
      return frag;
    }
    const lower = whole.toLowerCase();
    let at = 0;
    while (at < whole.length) {
      const found = lower.indexOf(needle, at);
      if (found < 0) {
        frag.appendChild(document.createTextNode(whole.slice(at)));
        break;
      }
      if (found > at) { frag.appendChild(document.createTextNode(whole.slice(at, found))); }
      const mark = document.createElement("mark");
      mark.textContent = whole.slice(found, found + needle.length);
      frag.appendChild(mark);
      at = found + needle.length;
    }
    return frag;
  }

  function moveFileSearchSel(delta) {
    if (fileSearch.items.length === 0) { return; }
    fileSearch.sel = (fileSearch.sel + delta + fileSearch.items.length) % fileSearch.items.length;
    const rows = fileSearch.body.querySelectorAll(".fs-row");
    for (let i = 0; i < rows.length; i += 1) { rows[i].classList.toggle("on", i === fileSearch.sel); }
    scrollFileSearchSel();
  }

  function scrollFileSearchSel() {
    const row = fileSearch.body.querySelector(".fs-row.on");
    if (row && row.scrollIntoView) { row.scrollIntoView({ block: "nearest" }); }
  }

  function chooseFileSearchItem(idx) {
    const item = fileSearch.items[idx];
    if (!item) { return; }
    // 内容那一档的结果自带行号；点同名链接弹出来的那次，停在那条链接说的行
    const line = item.line || fileSearch.line || 0;
    closeFileSearch();
    openFileDirect(item.path, line, 0);
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
    if (!item.reasoning) {
      const unsupported = document.createElement("div"); unsupported.className = "pk-thinking-unsupported"; unsupported.textContent = "不支持推理";
      right.appendChild(unsupported);
      return;
    }
    const label = document.createElement("div"); label.className = "pk-thinking-label"; label.textContent = "推理强度";
    right.appendChild(label);
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
    // 底部只说一件从别处看不出来的事：该选推理强度却还没选（那时的「确认切换」是灰的）。
    // 选了哪个模型、什么推理强度，选中那一行自己写着，不再抄一遍。
    const needsThinking = !!st.draftModel && st.draftModel.reasoning
      && !st.draftThinking && modelThinkingLevels(st.draftModel).length > 0;
    if (needsThinking) {
      const summary = document.createElement("div"); summary.className = "pk-footer-summary";
      summary.textContent = "先选一个推理强度";
      view.footer.appendChild(summary);
    }
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
        // 行下那行只写跟上面那个 id 不一样的名字：provider 上面分组标题已经写了，不再重复。
        const desc = item.name && item.name !== item.id ? item.name : "";
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
        // 行首那一块（子会话的拐角箭头、那颗小点、名字）
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
        // 行尾不再挂「当前」/「在跑」：当前那条靠整行的底色认，在跑 / 跑完了靠行首那颗小点。
        el.appendChild(main);
        if (item.pendingClose) {
          // 点过行尾那颗叉（这个会话正在跑，还得再点一下）：整行底色变红，行尾多一颗勾——点勾才真关，点叉撤销。
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
          // 关闭按钮放行尾：点行是切过去（大目标），点这颗才关（会话正在跑时要再点一下勾）。
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
        // 会话数不显示（那个数字对看列表没用，还容易被当成未读数）
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
    // 最底下那颗接的是工作区（目录），组里那颗接的是会话：写明“工作区”，不然两颗看着一样
    btn.textContent = loading ? "加载中…" : (isSpaces ? "加载更多工作区" : "加载更多");
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
    // 「正在对话」段：点行就是切过去（不新开、不重载），行尾那颗 × 是关闭（正在跑的会话要再点一下勾）。
    // 确认条正开着的时候点行身也是切过去：先把确认条撤掉 —— 点勾才真关，行身不能替那颗勾点实了。
    if (item.__section === "open") {
      if (item.pendingClose) { cancelPendingClose(); refreshOpenSessionsInPicker(); }
      closeFirst();
      requestSwitch(item.sessionId);
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
      // 宿主跟着工作区一块送回来的“展开着的那几组”的第一批会话（见 expandedDirsForHost）：
      // 先铺进去，这一画就是整的。
      if (Array.isArray(msg.groups)) {
        for (const g of msg.groups) {
          if (!g || typeof g.path !== "string" || !g.path) { continue; }
          const items = Array.isArray(g.items) ? g.items : [];
          // 一条都没扫到（目录没了、路径写法跟宿主对不上）就不当它“已经取回”：
          // 照旧走下面那条一趟，拿组头自己带的真路径重新要一遍。
          if (items.length === 0) { continue; }
          st.groups.set(normPathKey(g.path), {
            items,
            nextOffset: typeof g.nextOffset === "number" ? g.nextOffset : 0,
            hasMore: !!g.hasMore,
            loading: false,
            loaded: true,
          });
        }
      }
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
  /** 记住的那一份（目录的真路径，发给宿主去扫会话就靠它）；null = 这台设备上还没记过
   *  （那就只展开当前会话所在的那个）。比来比去一律走 samePath，不按字面比。 */
  let expandedDirs = readExpandedDirs();

  function readExpandedDirs() {
    try {
      const raw = localStorage.getItem(EXPANDED_STORE_KEY);
      if (!raw) { return null; }
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) { return null; }
      // 存过但存的是空数组 = “全都收起了”：跟“没存过”不一样，别当成没记过又自己展开当前那个
      return new Set(arr.filter((p) => typeof p === "string" && p.length > 0));
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
    for (const p of expandedDirs) { if (samePath(p, path)) { return true; } }
    return false;
  }

  /**
   * 这台设备上展开着的那几个目录（真路径）。
   * 打开面板时跟着一起发给宿主：让它把这几组的第一批会话跟工作区一起带回来，
   * 面板一画就是整的 —— 不至于先只出现文件夹，过一会儿才冒出里面的会话。
   */
  function expandedDirsForHost() {
    if (expandedDirs === null) {
      const cur = activeSessionCwd();
      return cur ? [cur] : [];
    }
    return Array.from(expandedDirs);
  }

  /** 点一下组头：展开 / 收起，并把结果记住。 */
  function toggleGroup(path) {
    if (expandedDirs === null) {
      expandedDirs = new Set();
      const cur = activeSessionCwd();
      if (cur) { expandedDirs.add(cur); }
    }
    const found = Array.from(expandedDirs).find((p) => samePath(p, path));
    if (found) { expandedDirs.delete(found); } else { expandedDirs.add(path); }
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
    // 收起了、或者窗口窄了：那一列不在屏上，里头留着的那份不算“正画着”（别让别处以为它还开着）
    if (sidebarDocked() && dockView.state.kind === kind) { return dockView; }
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
    // 这张抽屉是替“一个会话都没有”摊开的：拼出来的时候会话已经开好了就别弹了
    if (kind === "workspace" && msg.dock !== true && emptyWorkspace === "asked") {
      if (sessions.size > 0) {
        emptyWorkspace = "";
        vscode.postMessage({ type: "pickerCancel", kind: "workspace" });
        return;
      }
      emptyWorkspace = "shown";
    }
    const toggle = !!msg.toggle;
    // 「项目与会话」画到哪儿：宽窗 + 用户没收起 → 右边那一列（#sidebarDock，见上面“常驻的项目与会话侧边栏”）；
    // 窄窗（手机、窄面板）→ 浮层里那张抽屉。别的拾取器一律画在浮层那份里。
    // 这一下已经收起 / 变窄了就当没收到（不然收起了还弹一张抽屉出来），并告诉宿主别再等着。
    // 唯一的例外是“常驻那一列”那一份（msg.dock）：只要窗口还是宽的，收起着也照画 -
    // 那一列这会儿 display:none，看不见，但它是留着下次展开用的：这样展开时那份就是现的，
    // 不用再瞪着空列等一趟宿主扫磁盘。
    if (view === null) {
      if (kind !== "workspace") {
        view = modalView;
      } else if (msg.dock === true) {
        if (!sidebarWide()) {
          vscode.postMessage({ type: "pickerCancel", kind: "workspace" });
          return;
        }
        view = dockView;
      } else {
        if (sidebarWide()) {
          vscode.postMessage({ type: "pickerCancel", kind: "workspace" });
          return;
        }
        view = modalView;
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
      // 「统计」：这个会话里各个工具花了多久（同一个浮层壳子，见 renderToolStats）
      const statsBtn = document.createElement("button"); statsBtn.type = "button";
      statsBtn.className = "secondary pk-footer-stats";
      statsBtn.title = "看这个会话里各个工具调了多少次、花了多久";
      statsBtn.innerHTML = ICONS.chart + "<span>统计</span>";
      statsBtn.addEventListener("click", () => {
        if (!view.keepOpen) { cancelPicker(view); }
        openToolStats();
      });
      view.footer.appendChild(statsBtn);
      // 「工具」：这个会话加载着什么（工具 / 技能 / MCP 服务器）。清单是 pi 里那个扩展报上来的，
      // 后端存着最近一份，点开这颗按钮现要一次（见下面 renderEnv）。
      const envBtn = document.createElement("button"); envBtn.type = "button";
      envBtn.className = "secondary pk-footer-env";
      envBtn.title = "看这个会话现在有哪些工具、技能、MCP 服务器";
      envBtn.innerHTML = ICONS.tools + "<span>工具</span>";
      envBtn.addEventListener("click", () => {
        if (!view.keepOpen) { cancelPicker(view); }
        openEnv();
      });
      view.footer.appendChild(envBtn);
      // 「截图」：请插件截一张跑后端的这台电脑的桌面（手机上常用）。这颗按钮归 browserBridge.js 建，
      // 这里只管把它排在「统计」后头；后端说截不了桌面时它压根不存在。
      const shotBtn = typeof window.pichatScreenshotButton === "function" ? window.pichatScreenshotButton() : null;
      if (shotBtn) { view.footer.appendChild(shotBtn); }
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
    // 焦点落在面板本身，不进那个筛选框（以前打开就把光标放进筛选框）：手机上一弹键盘，
    // 可视高度被压掉一截，这层（高度跟着内容、最高 80vh）就跟着缩成很小一块。
    // 给面板一个落脚处是必要的：焦点留在底下那个输入框里的话，敲字 / 回车就喂给对话了。
    // 要筛就在弹窗里点一下那个框。
    if (!toDock && view.panel) { setTimeout(() => view.panel.focus({ preventScroll: true }), 0); }
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
        badge.textContent = it.source === "skill" ? "技能" : it.source === "prompt" ? "模板" : it.source === "extension" ? "命令" : it.source === "builtin" ? "插件" : "";
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
  // 输入框底下那颗胶囊的点击：切当前会话的模型。
  if (ctxIconEl) {
    ctxIconEl.addEventListener("click", () => {
      const st = activeSession();
      if (!st) { return; }
      vscode.postMessage({ type: "pickModel", sessionId: st.id, t0: performance.now() });
    });
  }

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
  // 输入框有没有焦点，报给后端：有焦点就是“人正坐在这块屏前看着这个会话”，
  // 这种时候某会话跑完一轮不用再弹提醒（见 chatControllerBase 的 noteInputFocus）。
  // 窗口失焦、页面退到后台也会让输入框失焦，但浏览器不一定补那条 blur，所以两处都听。
  const postInputFocus = (focused) => vscode.postMessage({ type: "inputFocus", focused });
  inputEl.addEventListener("focus", () => postInputFocus(true));
  inputEl.addEventListener("blur", () => postInputFocus(false));
  window.addEventListener("blur", () => postInputFocus(false));
  window.addEventListener("focus", () => postInputFocus(document.activeElement === inputEl));
  document.addEventListener("visibilitychange", () => { if (document.hidden) { postInputFocus(false); } });
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
   * 这个会话这一轮跑完了：名字旁边那颗点变绿（不闪），不管当时你有没有看着它。
   * 看一眼（切到那个会话）或者又开始跑下一轮就收掉。
   */
  function markTurnDone(st) {
    if (st.turnDone) { return; }
    st.turnDone = true;
    renderSessionBar();
    refreshOpenSessionsInPicker();
  }

  function setStreaming(st, on) {
    st.streaming = on;
    // 又开始跑下一轮：上一轮那颗绿点收掉（绿点只说“这一轮跑完了”）
    if (on) { st.turnDone = false; }
    // 这一轮跑完：还在留的那条位置到此为止（一轮里最后调的是工具、后面没再出正文时，就靠这一下收）
    if (!on) { endRunningLine(st); }
    if (activeId === st.id) { updateSendState(); syncStatus(); }
    renderSessionBar();
    syncEndHint(st);
    refreshOpenSessionsInPicker();
  }
  function setActivity(st, activity, detail) {
    st.activity = activity || (st.streaming ? "working" : "idle");
    st.activityDetail = detail || "";
    if (activeId === st.id) { syncStatus(); }
    refreshOpenSessionsInPicker();
  }
  function setPiReady(st, on, force) {
    st.piReady = on;
    if (activeId === st.id) { updateSendState(); syncStatus(); }
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
        // 自动模式：每次列表都带一份（跟模型名一样，是一次性推送的补位）——
        // 刷新页面 / 重连后那颗按钮亮不亮就靠它回来。
        st.auto = s.auto || null;
        st.autoTitle = s.autoTitle || null;
        syncSessionLoading(st);
        // 界面重建（网页重连、视图隐藏重开、窗口重载）后 sessionList 是唯一信源：
        // modelChanged 是一次性推送，不在此恢复会导致输入框底下那颗胶囊的模型名丢失。
        // 字段缺失（后端尚未拿到）时保留本地已有值。
        if (typeof s.modelId === "string") { st.modelId = s.modelId; }
        if (typeof s.provider === "string") { st.provider = s.provider; }
        if (typeof s.thinkingLevel === "string") { st.thinkingLevel = s.thinkingLevel; }
        if (typeof s.percent === "number") { st.percent = s.percent; }
        // 生成速度：后端一直记着上一轮的数（见 runtime 的 postTps），刷新页面也还在
        if (typeof s.tps === "number") { st.tps = s.tps; }
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
      // 一个会话都不剩时不留：没有别的可切，就回到“还没有会话”那一屏，等人挑一个工作区。
      Array.from(sessions.keys()).forEach((id) => {
        if (seen.has(id)) { return; }
        if (incoming.length > 0 && id === activeId && pendingCloseId !== id) { return; }
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
        else if (activeId && sessions.has(activeId)) { mountActiveSession(); syncStatus(); renderAutoIndicator(); }
      } else if (activeId && sessions.has(activeId)) {
        mountActiveSession();
        renderAutoIndicator();
      }
      renderSessionBar();
      // 会话目录这时候才认识：这一列开着又空着的话，把「目录」那一格摆上（见票 13）
      ensureProjectDirTab();
      updateSendState();
      syncStatus();
      refreshOpenSessionsInPicker();
      // 常驻的项目与会话侧边栏在这一批会话到了之后才要内容：不然上半那份「正在对话」是空的
      ensureSidebarPanel();
      // 一个会话都没有（刚打开页面、或者刚把最后几个关掉）：不空着等，把「项目与会话」摊开，
      // 等人在某个工作区里开新会话、或挑一条历史会话
      if (sessions.size === 0) { openWorkspaceForEmpty(); }
      // 有会话了就把替“没有会话”自己摊开的那张抽屉收起来（常驻那一列照旧开着）
      else if (emptyWorkspace === "shown" && modalView.state && modalView.state.kind === "workspace") { cancelPicker(modalView); }
      // 刚连上的这一批会话里可能已经有就绪的：把排队中的消息发出去
      flushPendingSend();
      // 会话列表来了（连上 / 新建 / 一轮跑完 / 切换）：闲下来后把别的会话的版先排好
      scheduleKeep();
      return;
    }
    if (type === "sessionActivated") {
      const id = msg.sessionId;
      // 会话壳要先在（列表可能晚一步）：不在就先记着，等它出现在列表里再切
      if (id && sessions.has(id)) { pendingActivateId = null; activateSessionView(id); }
      else if (id) { pendingActivateId = id; }
      // 搜索框开着：换成这个会话的目录重搜一次（上一个会话那份结果已经作废）
      if (fileSearch.open) { runFileSearch(); }
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
    if (type === "findResults") { onFindResults(msg); return; }
    if (type === "pathCandidatesResult") { onPathCandidates(msg); return; }
    if (type === "viewOptionItems") { viewOptionItems = Array.isArray(msg.items) ? msg.items : []; renderViewOpts(); return; }
    // 「编译并重启」那颗按钮的回话：后端马上要退了，成败就改那行说明（成不成它都会断，自己会连回来）
    if (type === "restartStatus") {
      if (restartNoteEl) { restartNoteEl.textContent = msg.text || ""; }
      return;
    }
    if (type === "focusInput") { setTimeout(function () { inputEl.focus(); }, 0); return; }
    // 宿主（VSCode 的命令入口，比如"发送选中文本"）替用户发一条：当作他打进输入框的，
    // 走同一条路（会话还没就绪就先留着、就绪了自动补发）
    if (type === "sendFromHost") { sendFromHost(msg.text); return; }
    // 后端在某个会话跑完一轮时下发的消息（所有会话都会收到，带 sessionId）：把那个会话的名字
    // 旁边那颗点变绿（不管这块屏当时看着的是哪一个）。弹提醒不走这儿，走 Windows 通知区域那颗
    // 图标（见 src/trayIcon.ts）。
    // 子会话（别人派出去干活的）不标：它的结果会交回派它的那个会话，那边跑完自会标；
    // 子会话缩进挂在父会话下面，标了反而多一颗点。
    // 是不是子会话由后端算（child）：子会话跑完常常紧接着就被关掉，这边按会话列表里的
    // parentId 判会赶不上——那时它的壳已经不在了。
    if (type === "turnEnd") {
      if (msg.child === true) { return; }
      // 绿点只说“这一轮跑完了”：自己按 Esc 停掉的那一轮不算，不绿
      const done = msg.sessionId && msg.status === "done" ? sessions.get(msg.sessionId) : null;
      if (done) { markTurnDone(done); }
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
    // 不是正在看的那个：它马上要变，“停着”的那种不再留着排好的旧版了（见 keepStep 上面那段）
    if (t.id !== activeId) { unkeep(t); }
    // 这一条是“把历史再画一遍”（重放）还是刚发生的事（实时）：重放的插在重放游标处，
    // 实时的一律接到末尾——断线中间还在长的正文不该插进历史中间（见 placeUnit）
    t.replayNow = msg.replay === true;
    // 从零重画的那一串（见 startReplayBuf）：先攒着，收尾时只画最后一截。
    // 实时来的渲染类消息一到，说明这一串已经过去了（syncPoint 丢了也走到这儿）：先把攒的画出来。
    if (t.replayBuf) {
      if (REPLAY_BUF_TYPES.has(type) && (msg.replay === true || type === "askCard" || type === "askCardDone")) {
        t.replayBuf.events.push(msg);
        return;
      }
      if (msg.replay !== true && REPLAY_BUF_TYPES.has(type)) { flushReplayBuf(t); }
    }
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
        addPlain(t, "user", "你", label + (msg.text || ""), msg.id);
        endThinking(t, "");
        scrollToBottom(t, true);
        // 新一轮开始了：窗格里的轮数超了就把最老的几轮搬去顶上那条占位（见 trimLiveTurns）
        scheduleTrimLive(t);
        // 刚发出去的这条把末尾那颗胶囊挤到了前头：重算一次（生成中会换成「卡住了」）
        syncEndHint(t);
        break;
      }
      case "streamStart":
        t.noCountPop = false;   // 模型开始回了：这一轮里后面长出来的次数都是新的
        t.activity = msg.activity || "working";
        t.activityDetail = msg.detail || "";
        // 新一轮生成：速度清零（后端 agent_start 也从零开始算，数跟消息一起过来）
        if (!t.replayNow) { t.tps = undefined; }
        setStreaming(t, true);
        finalizeCurrentAssistant(t);
        endThinking(t, "");
        break;
      case "streamEnd":
        if (t.rafId) { flushDeltas(t); }
        finalizeCurrentAssistant(t);
        endThinking(t, "");   // 想一半被中止（或后端没发收尾）：标签也得停住
        t.activity = msg.activity || "idle";
        t.activityDetail = msg.detail || "";
        setStreaming(t, false);
        // 这一轮跑到这儿就停了：末尾要是还挂着一颗「补来的思考」，并回本段那颗
        foldTailThinking(t);
        // 跑完的提醒由后端走 Windows 通知区域那颗图标（见 src/trayIcon.ts），这儿不出声。
        break;
      case "activityChanged":
        setActivity(t, msg.activity, msg.detail);
        // 离开「思考中」就说明这一段想完了：个别 provider 不发 thinking_end 时在这里兜底收尾
        if (msg.activity !== "thinking") { endThinking(t, ""); }
        break;
      case "assistantDelta":
        if (!t.currentAssistant) {
          t.currentAssistant = { el: addMarkdown(t, ""), raw: "" };
          // 正文开吐了：胶囊那颗动画从「等」换成「写」（见 syncStatus 里的 data-act）
          if (activeId === t.id) { syncStatus(); }
        }
        t.currentAssistant.raw += msg.delta;
        t.textDirty = true;
        scheduleFlush(t);
        break;
      case "assistantFull":
        finalizeCurrentAssistant(t);
        addMarkdown(t, msg.text, msg.at, msg.id);
        t.currentAssistant = null;
        break;
      case "thinkingStart": {
        const entry = startThinking(t);
        // 这段思考的编号：后端一个字都不发，点开时要按它取全文（见 clipOf / pumpClipDetails）
        if (typeof msg.detailKey === "string" && msg.detailKey) { entry.clipKey = msg.detailKey; }
        break;
      }
      case "thinkingDelta": {
        // 兼容较旧后端：即使没有先收到 thinkingStart，也按正在思考渲染。
        if (t.activity !== "thinking") { t.activity = "thinking"; }
        const thinking = startThinking(t);
        thinking.resultText += msg.delta;
        if (typeof msg.detailKey === "string" && msg.detailKey) { thinking.clipKey = msg.detailKey; }
        if (typeof msg.omitted === "number" && msg.omitted > 0) {
          thinking.clip = { key: thinking.clipKey, omitted: msg.omitted, loaded: false, failed: false };
        }
        refreshTagTipIfShowing(thinking.group.tag);   // 提示框开着时跟着长大
        break;
      }
      case "thinkingFull":
        // 想完一段：整段文本随 pi 的 thinking_end 过来（历史重放也只来这一条），见 endThinking。
        // 正在往暂存区补更早的历史（t._stage）时另开一条，别动手头正在想的那一条。
        endThinking(t, msg.text, !!t._stage, msg);
        break;
      case "tool": {
            finalizeCurrentAssistant(t);
        const argStr = msg.args ? JSON.stringify(msg.args) : "";
        const item = addTool(t, msg.toolName, argStr, msg.toolCallId, !!msg.interrupted);
        // 参数一点没带过来（后端只留了“一共多少字 + 编号”）：点开提示框时再取（见 pumpClipDetails）
        if (item && typeof msg.argsOmitted === "number" && msg.detailKey) {
          const clip = { key: msg.detailKey, omitted: msg.argsOmitted, loaded: false, failed: false };
          if (item.nodeType) { item._argsClip = clip; } else { item.argsClip = clip; }
        }
        t.currentAssistant = null;
        break;
      }
      case "editCardStart": {
            finalizeCurrentAssistant(t);
        const card = buildEditCard(t, msg.toolName, msg.label, msg.path, msg.toolCallId,
          msg.args ? JSON.stringify(msg.args) : "", typeof msg.argsOmitted === "number");
        // 参数没带过来：记在卡片那条 entry 上，点开提示框时取回来（写入预览要它）
        if (typeof msg.argsOmitted === "number" && msg.detailKey) {
          card.entry.argsClip = { key: msg.detailKey, omitted: msg.argsOmitted, loaded: false, failed: false };
        }
        t.pendingToolCards.set(msg.toolCallId, card);
        t.currentAssistant = null;
        break;
      }
      case "editCardResult": {
        const card = t.pendingToolCards.get(msg.toolCallId);
        if (card) {
          noteToolDuration(t, card.toolName, card.callText, msg.durationMs);
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
      case "changesChanged": {
        // 本会话的改动清单变了（改完一个文件 / 刚回滚）：文件侧边栏那一格「改动」重问一遍
        if (t.id === activeId) { refreshChangesTab(); }
        break;
      }
      case "bashTask": {
        // 某条后台命令有动静（转到后台 / 跑完 / 被停）：文件侧边栏那一格「后台」跟着更新
        if (t.id === activeId) { applyBashTask(msg.task); }
        break;
      }
      case "envInfo": {
        // 「加载了什么」那份清单（点开那颗「工具」时要回来的 / 后端发现变了主动推来的）
        envSnapshot = msg.env || null;
        envSnapshotFor = typeof msg.sessionId === "string" ? msg.sessionId : t.id;
        envWaiting = false;
        if (envOpen()) { renderEnv(); }
        break;
      }
      case "system":
        addPlain(t, "system", null, msg.text, msg.id);
        break;
      case "systemError":
        addPlain(t, "system error", null, msg.text, msg.id);
        break;
      case "clear": {
        // 窗格这会儿是不是空的：空的就是“整屏从零画”（页面刷新 / 切会话 / 打开历史会话），
        // 这种可以把这一串重放攒着、只画最后一截（见 startReplayBuf）；重连那种
        // “窗格里本来就有东西”的走按编号对账（见 beginReconcile）。
        // 系统消息（「已回滚」那一类）不算：它们随重画一起没，重放里本来也不带它们。
        const fresh = !t.paneEl.querySelector(".msg:not(.system)");
        // 上一遍没画完的老消息作废（占位一起收掉）：这一遍要重新攒了
        dropOlderHint(t);
        if (t.viewRaf) { cancelAnimationFrame(t.viewRaf); t.viewRaf = 0; }
        if (t.viewTimer) { clearTimeout(t.viewTimer); t.viewTimer = 0; }
        // 后端说“接下来重放一遍历史”，而且这次每条都带编号：不清空窗格，按编号对账
        //（见 beginReconcile / placeUnit）——人正看着的那一段、图片、卡片里打的字都留着
        if (msg.reconcile && !fresh) { beginReconcile(t); break; }
        // 整屏重画（页面刷新 / 重连后补内容）也走 clear：这种 clear 带 keepDraft。
        // 窗格马上要清空重建，先把视野记下来，重画期间先不跟着滚（见 beginRedraw）
        if (msg.reconcile || msg.keepDraft) { beginRedraw(t); } else {
          // 换会话那种 clear：重画那一套（视野记号、先不跟着滚）一并收掉
          if (t.redrawTimer) { clearTimeout(t.redrawTimer); t.redrawTimer = null; }
          t.redrawRestore = null;
          t.suppressScroll = false;
          releaseAnchorHold(t);
        }
        // 接下来这一串是重放：先攒着，等收尾那条（syncPoint）到了再画最后一截
        startReplayBuf(t);
        cancelFlush(t);
        hideTagTip();
        // 重画历史（切会话 / 重连）随之开始：这之后涌进来的工具调用都是老消息，别飘 +1
        t.noCountPop = true;
        t.byId.clear();   // 窗格整个重写了：编号表跟着作废
        t.reconcile = null;
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
        t.currentToolTail = null;
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
      }
      case "toolResultUpdate": {
        // 缓存部分结果，悬浮提示随取随画
        const groupEntry = t.toolGroupEntries.get(msg.toolCallId);
        if (groupEntry) {
          groupEntry.resultText = msg.resultText || "";
          groupEntry.clip = clipOf(msg);
          groupEntry.meta = { isPartial: true, durationMs: msg.durationMs };
          refreshTagTipIfShowing(groupEntry.group.tag);
          break;
        }
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          tagEl._resultText = msg.resultText || "";
          tagEl._resultClip = clipOf(msg);
          tagEl._resultMeta = { isPartial: true, durationMs: msg.durationMs };
          setTagTip(tagEl, tagEl._resultText, "");
        }
        break;
      }
      case "toolsInterrupted":
        // 这些调用等不到结果了（那一轮被中断 / pi 进程没了）：把还转圈的标签收掉
        settleInterruptedTools(t, msg.toolCallIds);
        break;
      case "toolResult": {
        const groupEntry = t.toolGroupEntries.get(msg.toolCallId);
        if (groupEntry) {
          noteToolDuration(t, groupEntry.name, groupEntry.tipCall, msg.durationMs);
          // 合并组里的那一条：结果填回组里（提示框里那条的结果），标签上的条数/转圈/标红跟着重算
          if (Array.isArray(msg.images) && msg.images.length > 0) {
            removeEntryFromGroup(t, groupEntry, msg.images);
          } else {
            groupEntry.done = true;
            groupEntry.isError = !!msg.isError;
            groupEntry.resultText = msg.resultText || "";
            groupEntry.clip = clipOf(msg);
            groupEntry.meta = { isError: !!msg.isError, durationMs: msg.durationMs, truncation: msg.truncation || null };
            t.toolGroupEntries.delete(msg.toolCallId);
            syncGroupTag(t, groupEntry.group);
            scrollToBottom(t);
          }
          break;
        }
        const tagEl = t.pendingToolTags.get(msg.toolCallId);
        if (tagEl) {
          noteToolDuration(t, tagEl._toolName, tagEl._tipCall, msg.durationMs);
          tagEl.classList.remove("running");
          syncRunningLine(t);   // 这条不跑了：末尾那行跟着少一条
          if (msg.isError) { tagEl.classList.add("error"); }
          // 记录结果：文字结果供悬浮提示用（见 setTagTip），带图的走另一条路
          tagEl._done = true;
          tagEl._isError = !!msg.isError;
          tagEl._resultText = msg.resultText || "";
          tagEl._resultClip = clipOf(msg);
          tagEl._resultMeta = { isError: !!msg.isError, durationMs: msg.durationMs, truncation: msg.truncation || null, images: msg.images || null };
          t.pendingToolTags.delete(msg.toolCallId);
          // read 读图：小标签收掉，换成对话里的一整块图（不再走悬浮提示）
          if (Array.isArray(msg.images) && msg.images.length > 0) {
            // 先插图、再收标签（行空了连行一起收）：顺序反过来就找不着图该待的地方了
            mountToolImageBlock(t, { toolName: tagEl._toolName, argStr: tagEl._argStr, tipCall: tagEl._tipCall, toolCallId: msg.toolCallId, row: tagEl.parentElement }, msg.images);
            dropToolTag(t, tagEl);
          } else {
            setTagTip(tagEl, tagEl._resultText, "");
          }
        }
        break;
      }
      case "details": {
        // 点开时要的那一批内容回来了（见 startClipPump）：换到打开着的那个提示框里。
        // 提示框已经关了就不管了——下次点开再要一次（后端那边留着，要点很快）。
        const open = tagTipTag;
        if (!open) { break; }
        const items = msg.items && typeof msg.items === "object" ? msg.items : {};
        const missing = Array.isArray(msg.missing) ? msg.missing : [];
        const textOf = (key) => (typeof items[key] === "string" ? items[key] : (missing.indexOf(key) >= 0 ? null : undefined));
        const apply = (clip, setText) => {
          if (!clip) { return; }
          const text = textOf(clip.key);
          if (text === undefined) { return; }
          if (text === null) { clip.failed = true; return; }
          clip.loaded = true;
          setText(text);
        };
        // 参数也走同一条回话：换掉那一行调用摘要（write 卡片换掉整份参数，写入预览才画得出来）
        const applyArgs = (argsClip, put) => {
          if (!argsClip) { return; }
          const text = textOf(argsClip.key);
          if (text === undefined) { return; }
          if (text === null) { argsClip.failed = true; return; }
          argsClip.loaded = true;
          put(text);
        };
        const g = open._tipGroup;
        if (g) {
          for (const e of g.entries) {
            apply(e.clip, (text) => { e.resultText = text; });
            applyArgs(e.argsClip, (text) => {
              e.argStr = text;
              e.tipCall = tagTipCallText(e.name, text);
              if (e.applyArgs) { e.applyArgs(text); }
            });
          }
        } else {
          apply(open._resultClip, (text) => { open._resultText = text; setTagTip(open, text, ""); });
          applyArgs(open._argsClip, (text) => {
            open._argStr = text;
            open._tipCall = tagTipCallText(open._toolName, text);
          });
        }
        refreshTagTipIfShowing(open);
        if (!clipNeedsMore(open)) { stopClipPump(); }
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
        break;
      case "auto":
        // 开关状态（自动模式）：界面上只是那颗按钮亮不亮，不往消息流里写
        t.auto = msg.auto || null;
        t.autoTitle = msg.title || null;
        if (activeId === t.id) { renderAutoIndicator(); }
        break;
      case "thinkingChanged":
        t.thinkingLevel = msg.level || "";
        if (activeId === t.id) { syncStatus(); }
        break;
      case "syncPoint":
        // 插件说“这一屏补发 / 重画完了”：对账的重放就此收尾；
        // 清空重画那种则把视野放回原处（不在重画的都是空转）
        for (const st of sessions.values()) {
          flushReplayBuf(st);
          if (st.reconcile) { endReconcile(st); }
          else if (st.suppressScroll) { finishRedraw(st); }
        }
        // 一大批重放刚结束：闲下来后把别的会话的版先排好（见 scheduleKeep）
        scheduleKeep();
        break;
      case "tps": {
        // 生成速度（t/s）：后端算好了推来（250ms 一次，跑完推最后那个数），只写数字不重算
        t.tps = typeof msg.value === "number" ? msg.value : undefined;
        if (activeId === t.id) { syncStatus(); }
        break;
      }
      case "stats": {
        // 上下文用量：输入框底下那颗胶囊（用量百分比与颜色预警）
        const cu = msg.contextUsage;
        if (cu) {
          if (typeof cu.percent === "number") { t.percent = cu.percent; }
          if (typeof cu.tokens === "number") { t.tokens = cu.tokens; }
          if (typeof cu.contextWindow === "number") { t.contextWindow = cu.contextWindow; }
        }
        if (activeId === t.id) { syncStatus(); }
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
        if (t.reconcile) {
          t.reconcile.historyWindow = true;
          t.reconcile.windowStart = msg.hasMore === true;
        }
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
    // 窗格里可能还撂着上一颗（按编号对账开始时 `_historyBtn` 被置空、那颗节点没收掉）：
    // 不收的话每重画一遍就多一颗，按钮会叠起来。这里统一收拾，不管是谁留下的。
    for (const el of Array.from(pane.children)) {
      if (el !== btn && el.classList && el.classList.contains("history-more")) { el.remove(); }
    }
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
    const pane = t.paneEl;
    // 尺子：插入点后面那条老消息（以及它此刻在视野里的位置）。
    // 为什么先量：后面 `setHistoryWindow` 可能把顶上那颗按钮收掉（最后一批时），
    // 上面一下子矮了三四十像素，而浏览器的滚动锚定这会儿被我们关着、不会自己补——
    // 量晚了就等于把这几像素白送出去（见 dev/historyScroll.js 差 35 像素那次）。
    const oldBtn = t._historyBtn && t._historyBtn.parentNode === pane ? t._historyBtn : null;
    const ruler = oldBtn ? oldBtn.nextElementSibling : pane.firstElementChild;
    const rulerViewTop = ruler ? ruler.offsetTop - pane.scrollTop : 0;
    setHistoryWindow(t, hasMore, hidden);
    if (!stage || !stage.childNodes.length) { return; }
    // 插到哪儿：顶部那个「加载更早」按钮还在就插在它后面；已经收掉了（这是最后一批）就插在最前面
    const btn = t._historyBtn && t._historyBtn.parentNode === pane ? t._historyBtn : null;
    const at = btn ? btn.nextSibling : pane.firstChild;
    const beforeHeight = pane.scrollHeight;
    // 这一下由我们自己补滚动位置：先把浏览器的滚动锚定临时关掉，
    // 它也会因为“上方变高”补一次，两边叠起来视野就被推下去一整批的高度。
    const prevAnchorStyle = pane.style.overflowAnchor;
    pane.style.overflowAnchor = "none";
    while (stage.firstChild) { pane.insertBefore(stage.firstChild, at); }
    const grew = pane.scrollHeight - beforeHeight;
    let grewLeft = grew;
    const putBack = () => {
      if (!paneShown(pane)) { return; }
      if (ruler && ruler.parentNode === pane) {
        // 按“尺子还该在视野里那个位置”直接对（不是累加差）：这函数要跑好几帧，
        // 累加会补成好几倍；按钮被收掉那种“上面矮了一截”也能一次对回来
        const want = Math.max(0, ruler.offsetTop - rulerViewTop);
        if (Math.abs(want - pane.scrollTop) > 0.5) { pane.scrollTop = want; }
      } else if (grewLeft) {
        // 尺子没了（窗格没挂在页面上、那一行被换掉）：退回按高度差补，也只补这一回
        pane.scrollTop += grewLeft;
        grewLeft = 0;
      }
    };
    putBack();
    // 后到的高度（图片解码、高亮重排）会让它再跑一点：再对两帧位置，然后把滚动锚定还给浏览器
    let frames = ruler && paneShown(pane) ? 2 : 0;
    const settle = () => {
      putBack();
      frames--;
      if (frames > 0) { requestAnimationFrame(settle); return; }
      pane.style.overflowAnchor = prevAnchorStyle;
      // 几帧对不完：这一批里的图解码还要再撑高一点（几十像素），插在上面就会把视野往下挤。
      // 再盯一小会儿（人一碰就停），跟整屏重画那边同一套
      if (ruler && ruler.parentNode === pane) { holdScrollOn(t, ruler); }
    };
    if (frames > 0) { requestAnimationFrame(settle); } else { pane.style.overflowAnchor = prevAnchorStyle; }
  }

  // ==================== 从零重画时只画最后一截（“虚拟列表”的简化版）====================
  //
  // 打开一个长会话是“清空 + 一条条重放”：两百条消息全做成节点，屏幕只看得到十几条。
  // 量过（手机视口、4 倍降速）：两百条解析约 100 毫秒、排版 300—400 毫秒。所以从零重画时
  // 先把这一串重放攒着（replayBuf），收尾时只画最后 TAIL_TURNS 轮，上面没画的那几轮缩成
  // 一条占位（.older-hint），高度按已经画出来的平均高度估；人往上滚到跟前再补，一次
  // CHUNK_TURNS 轮，补完把视野钉回原来那条上（跟「加载更早」同一套，见 flushHistoryBatch）。
  //
  // 只对“窗格是空的、整屏从零画”生效（页面刷新、切会话、打开历史会话）。重连那种
  // “按编号对账”的重画（reconcile）页面上本来就有节点，走老路。
  const TAIL_TURNS = 8;      // 收尾时先画最后这么多轮（一轮 = 一条用户消息起头）
  const CHUNK_TURNS = 5;     // 往上一帧补这么多轮（一帧补多了人会感到卡，见 syncViewport）
  const OLDER_NEAR_PX = 700; // 离顶这么近就开始补（比一屏多一点，滚到头之前就该出来）
  // 窗格里最多留多少轮、一次搬走之后留多少轮（见 trimLiveTurns）：页面一直开着、会话一直
  // 在跑，新消息就一路往 DOM 里加，跑久了就是几千条——手机上切一次要几百毫秒（量法见
  // dev/switchPerf.js --cpu 4 --width 412 --height 915：58 条时 25~80 毫秒，2855 条时
  // 130~340 毫秒）。留几十轮就够看。
  const LIVE_MAX_TURNS = 40;
  const LIVE_KEEP_TURNS = 24;
  /** 重放里会往窗格里落东西的那几种；其余（clear / syncPoint / stats 这些）当场办。 */
  const REPLAY_BUF_TYPES = new Set([
    "userMessage", "assistantDelta", "assistantFull",
    "thinkingStart", "thinkingDelta", "thinkingFull",
    "tool", "toolResult", "toolResultUpdate", "toolsInterrupted",
    "editCardStart", "editCardResult", "resultImage",
    "system", "systemError", "askCard", "askCardDone",
  ]);

  /** 开始攒重放：接下来这一串先不画，等收尾那一条（syncPoint）来了再说。 */
  function startReplayBuf(st) {
    st.replayBuf = { events: [] };
  }

  /** 这一串里从后往前数第 turns 条用户消息的下标（不够就 0 = 全画）。
   *  切在用户消息上而不是随便一条消息上：一轮问答摊成好几块节点（正文 / think / 工具行），
   *  从中间切开会让第一块单独落在上面，看着像半轮从天上掉下来。 */
  function cutIndexForTurns(events, turns) {
    let n = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].type !== "userMessage") { continue; }
      n += 1;
      if (n >= turns) { return i; }
    }
    return 0;
  }

  /**
   * 已经画出来的消息平均多高（占位按它估；画出来的太少就按 120 像素）。
   * 先摸一个把排版逼出来，后面那些读的就是现成的版面了——不这么做，每读一个孩子都
   * 会触发一次“看看排版脏没脏”，首屏收尾那一下量出来 112 毫秒几乎全耗在这儿。
   */
  function avgMessageHeight(pane) {
    let sum = 0;
    let n = 0;
    let forced = false;
    for (const el of pane.children) {
      if (!el.classList || !el.classList.contains("msg")) { continue; }
      if (!forced) { pane.offsetHeight; forced = true; }
      const h = el.offsetHeight;
      if (h > 0) { sum += h; n += 1; }
    }
    return n >= 3 ? sum / n : 120;
  }

  /** 这一截里还有几轮（一轮 = 一条用户消息起头）：占位上那个数字用它。
   *  项有两种：一条还没画的消息事件（从零重画时攒下的），或者一截已经画好、被搬出来的节点
   *  （见 trimLiveTurns）。 */
  function countTurns(events) {
    let n = 0;
    for (const item of events) { n += olderTurnCount(item); }
    return n;
  }

  /**
   * st.older 一共顶着多长：占位的高度按它估。
   * 一截搬出来的节点按里面的节点个数算，一条待画的消息按一块算（跟以前只有事件时一个意思）。
   */
  function olderBlockCount(older) {
    let n = 0;
    for (const item of older || []) { n += item && item.nodes ? item.nodes.length : 1; }
    return n;
  }

  /** 一项里有几轮。 */
  function olderTurnCount(item) {
    if (!item) { return 0; }
    if (item.nodes) {
      let n = 0;
      for (const node of item.nodes) { if (isTurnStart(node)) { n += 1; } }
      return n;
    }
    return item.type === "userMessage" ? 1 : 0;
  }

  /** 这一条是不是“一轮的开头”（气泡是用户自己说的那条）。 */
  function isTurnStart(node) {
    return !!node && node.nodeType === 1 && node.classList
      && node.classList.contains("msg") && node.classList.contains("user");
  }

  /**
   * 从 st.older 末尾取几轮出来（离已经画好的那段最近的先取）。
   * 项里有好几轮时要按轮拆开：前面留着，后面取走（不然一帧就补进去十几轮，见 syncViewport）。
   * @returns {{ take: any[], rest: any[] }}
   */
  function takeOlderTail(older, turns) {
    const list = older.map(function (it) { return it && it.nodes ? { nodes: it.nodes.slice() } : it; });
    let want = turns;
    let start = list.length;   // 从这一项开始都归“取走”
    while (start > 0 && want > 0) {
      const item = list[start - 1];
      const n = olderTurnCount(item);
      if (n === 0) { start -= 1; continue; }          // 不属任何一轮的那些：跟着后面一起走
      if (n <= want) { want -= n; start -= 1; continue; }
      // 这一项里有比要的还多的轮：在轮的界上拆成两截
      const nodes = item.nodes || [];
      let seen = 0;
      let at = 0;
      for (let k = nodes.length - 1; k >= 0; k -= 1) {
        if (!isTurnStart(nodes[k])) { continue; }
        seen += 1;
        if (seen === want) { at = k; break; }
      }
      if (at <= 0) { start -= 1; want = 0; break; }
      list[start - 1] = { nodes: nodes.slice(0, at) };
      list.splice(start, 0, { nodes: nodes.slice(at) });
      want = 0;
      break;
    }
    return { take: list.slice(start), rest: list.slice(0, start) };
  }

  /**
   * 窗格里的轮数超了：把最老的几轮搬出窗格，交给顶上那条占位（往上滑再画回来）。
   *
   * 搬的是已经画好的节点，原样收着（见 st.older 的两种项），补回来时直接挂回去，不重画、
   * 不重新排版。只动最老的那几轮：末尾正在长的那一段（正文、工具行、末尾胶囊）一律不碰。
   * 人正在往上翻历史（不贴底）时不动手——搬走的正是他眼看着的那一段。
   */
  function trimLiveTurns(st) {
    if (!st || st.olderBusy || st.reconcile || st.redrawRestore || st.loading) { return; }
    const pane = st.paneEl;
    if (!pane || !pane.parentNode) { return; }
    if (st.id === activeId && !st.stickToBottom) { return; }
    const starts = [];
    for (const el of pane.children) { if (isTurnStart(el)) { starts.push(el); } }
    if (starts.length <= LIVE_MAX_TURNS) { return; }
    // 从第一轮搬到“留下 LIVE_KEEP_TURNS 轮”那个位置之前；占位、「加载更早」排在第一轮前面，不动
    const endEl = starts[starts.length - LIVE_KEEP_TURNS];
    const nodes = [];
    let el = starts[0];
    while (el && el !== endEl) {
      const next = el.nextSibling;
      nodes.push(el);
      el = next;
    }
    if (!nodes.length) { return; }
    for (const node of nodes) {
      const mid = node.dataset ? node.dataset.mid : "";
      if (mid && st.byId.get(mid) === node) { st.byId.delete(mid); }
      node.remove();
    }
    // 刚搬出去的这几轮比 st.older 里现有的都新：接在末尾（往上补时也是从末尾往回画）
    st.older = (st.older || []).concat([{ nodes: nodes }]);
    mountOlderHint(st, olderBlockCount(st.older));
    if (st.stickToBottom) { scrollToBottom(st, true); }
  }

  /** 攒够了就搬（用户消息来了才查：一轮一回，节流一下，别跟流式输出抢那一帧）。 */
  function scheduleTrimLive(st) {
    if (st.trimTimer) { return; }
    st.trimTimer = setTimeout(function () {
      st.trimTimer = 0;
      trimLiveTurns(st);
    }, 400);
  }

  /** 顶上那条占位：写还剩几轮，高度按平均高度估。估不准不影响内容，只影响滚动条长短。 */
  function mountOlderHint(st, count) {
    const pane = st.paneEl;
    let el = st.olderHint;
    if (!el) {
      el = document.createElement("div");
      el.className = "older-hint";
      const label = document.createElement("span");
      label.className = "oh-text";
      el.appendChild(label);
      st.olderHint = el;
    }
    // 那行字粘在视野顶上（见 chat.css）：这块占位可能几十屏高，滚到中间也得看得见那句话
    el.firstChild.textContent = "往上还有 " + countTurns(st.older || []) + " 轮（往上滑就画）";
    el.style.height = Math.max(90, Math.round(avgMessageHeight(pane) * count)) + "px";
    // 摆在窗格最上面，但让着「加载更早」那颗：那颗管的是窗口外面更早的，比这儿还早
    const btn = st._historyBtn && st._historyBtn.parentNode === pane ? st._historyBtn : null;
    const at = btn ? btn.nextSibling : pane.firstChild;
    if (el.parentNode !== pane) { pane.insertBefore(el, at); }
  }

  /** 把占位收掉：上面那些老消息已经全画完了。 */
  function dropOlderHint(st) {
    st.older = null;
    if (st.olderHint) { st.olderHint.remove(); st.olderHint = null; }
  }

  /**
   * 收尾：把攒着的那一串画出来（只画最后一截，其余留在占位后面等着）。
   * 由 syncPoint（后端说“这一屏画完了”）触发，兜底还有那两个超时定时器与“实时消息来了”。
   */
  function flushReplayBuf(st) {
    const buf = st.replayBuf;
    st.replayBuf = null;
    if (!buf || !buf.events.length) { return; }
    const events = buf.events;
    const cut = cutIndexForTurns(events, TAIL_TURNS);
    const older = events.slice(0, cut);
    for (let i = cut; i < events.length; i += 1) { applyPanelMessage(events[i]); }
    if (older.length) {
      st.older = older;
      mountOlderHint(st, olderBlockCount(older));
    }
    // 窗格是空的、刚才什么也没滚：贴底的人直接到底（非重画那条路没有人帮忙滚，见 case "clear"）
    if (st.stickToBottom) { scrollToBottom(st, true); }
  }

  /**
   * 往上补一截：把 st.older 末尾的几轮画出来，插在占位下面，视野不动。
   * 画进暂存区再整块插（跟「加载更早」同一招）：这些东西该插到占位后面，不是接到末尾。
   */
  function fillOlder(st, turns) {
    const older = st.older;
    if (!older || !older.length || st.olderBusy) { return; }
    const pane = st.paneEl;
    if (!paneShown(pane)) { return; }
    st.olderBusy = true;
    try {
      const split = takeOlderTail(older, turns);
      const take = split.take;
      st.older = split.rest;
      // 这几个说的是“窗格末尾那一批”的落脚点（工具行 / 图块 / 那段思考），画老消息时
      // 不能让它们被改掉：另存一份，画完还回去。currentToolTail 置空让老消息自己另起一行。
      const stage = document.createElement("div");
      const saved = {
        pane: st.paneEl, stage: st._stage, stick: st.stickToBottom,
        tail: st.currentToolTail, asst: st.currentAssistant, think: st.thinkingEntry,
        seg: st.segmentThinking, tailThink: st.tailThinking, groups: st.toolGroups,
      };
      st._stage = stage;
      st.paneEl = stage;
      st.currentToolTail = null;
      st.toolGroups = null;
      try {
        for (const item of take) {
          // 搬出来收着的那一截：原样挂回去（不重画）
          if (item && item.nodes) {
            for (const node of item.nodes) { stage.appendChild(node); }
          } else {
            applyPanelMessage(item);
          }
        }
      } finally {
        st.paneEl = saved.pane;
        st._stage = saved.stage;
        st.stickToBottom = saved.stick;
        st.currentToolTail = saved.tail;
        st.currentAssistant = saved.asst;
        st.thinkingEntry = saved.think;
        st.segmentThinking = saved.seg;
        st.tailThinking = saved.tailThink;
        st.toolGroups = saved.groups;
      }
      if (!stage.childNodes.length) { dropOlderHintIfEmpty(st); return; }
      // 尺子：原来最上面那条消息现在在视野里的位置。补完按它放回去（同 flushHistoryBatch）。
      // 占位自己不算“最上面那条”：补出来的内容要插在它下面（不然占位会被压到补出来的
      // 那截下面去，整块顺序就乱了）。
      const hint = st.olderHint && st.olderHint.parentNode === pane ? st.olderHint : null;
      const ruler = hint ? hint.nextElementSibling : pane.firstElementChild;
      // 人已经划进那块空白里了（视野顶在占位中间）：这就不对位置了。补出来的东西让它自己
      // 长上来盖住视野——一按尺子对位置，等于把这片空白按在原地，人越补越看不见东西。
      const inside = !!hint && pane.scrollTop < headBottom(hint);
      const viewTop = ruler ? ruler.offsetTop - pane.scrollTop : 0;
      const prevAnchor = pane.style.overflowAnchor;
      pane.style.overflowAnchor = "none";
      let node = stage.firstChild;
      while (node) {
        const next = node.nextSibling;
        pane.insertBefore(node, ruler);
        node = next;
      }
      // 占位跟着缩（高度按这会儿量出来的平均高度重估：一开始估得不准，补一轮就准一轮）
      if (st.older.length) { mountOlderHint(st, olderBlockCount(st.older)); } else { dropOlderHint(st); }
      if (inside || !ruler || ruler.parentNode !== pane) {
        st.lastScrollTop = pane.scrollTop;
      } else {
        pane.scrollTop = Math.max(0, ruler.offsetTop - viewTop);
        st.lastScrollTop = pane.scrollTop;
      }
      pane.style.overflowAnchor = prevAnchor;
    } finally {
      st.olderBusy = false;
    }
  }

  /** 补完这一截没了可补的、内容又是空的（重放里这几条什么节点都没落）：别留个空占位。 */
  function dropOlderHintIfEmpty(st) {
    if (!st.older || !st.older.length) { dropOlderHint(st); }
  }

  /** 顶上那条占位的底边 = 已经画出来的内容从哪儿开始（没占位就是 0）。 */
  function headBottom(el) {
    if (!el || !el.parentNode) { return 0; }
    return el.offsetTop + el.offsetHeight;
  }

  /** 老消息那一截补到底了没有（补完才轮到“画过的收起来”）。 */
  function olderLeft(st) {
    return !!(st.older && st.older.length);
  }

  // 划得快（每毫秒一个像素以上）和慢悠悠地滚，补画的时机不一样：
  //   · 慢滚：离视野还有一屏多（OLDER_NEAR_PX）就开始补，人看不见补的过程；
  //   · 快划：补一截要一百多毫秒（四倍降速），提前补就是凭空多卡一下，所以只在
  //     “再划两下就真看见空白了”（FAST_NEAR_PX）才补。补一截能顶几屏，所以一路划过去
  //     也就补那么两三次；停下来 160 毫秒后由 scheduleViewportCheckLater 把剩下的补齐。
  //     完全不补这一版也量过：一路划过去一帧没卡，但人会一路看空白——不能那么干。
  const FAST_SCROLL_PX_PER_MS = 1.2;
  const FAST_SCROLL_GRACE_MS = 160;
  const FAST_NEAR_PX = 260;

  /**
   * 一帧看一眼：上面没画的那一截该不该补。
   *
   * “该补了”拿占位的底边当尺子（headBottom = 已画内容从哪儿开始），不是拿窗格顶上那 0：
   * 占位可能有几十屏高，人滚到分界跟前时窗格离顶还远着呢，按 0 算就永远轮不到它，
   * 人会一头扎进一块空地里滚不出来。
   */
  function syncViewport(st) {
    st.viewRaf = 0;
    const pane = st.paneEl;
    if (!paneShown(pane) || st.suppressScroll || st.streaming || st.olderBusy) { return; }
    if (!olderLeft(st)) { return; }
    const fast = Date.now() < st.scrollFastUntil;
    const near = fast ? FAST_NEAR_PX : OLDER_NEAR_PX;
    if (pane.scrollTop >= headBottom(st.olderHint) + near) { return; }
    // 一帧只补一截：一截是几轮（十几条消息），四倍降速下已经一百毫秒上下了，
    // 一帧补两三截就是几百毫秒的卡（量过：一帧补三截最长一帧 482 毫秒，补一截 214，补五轮 109）。
    fillOlder(st, CHUNK_TURNS);
    if (!olderLeft(st) || pane.scrollTop >= headBottom(st.olderHint) + near) { return; }
    // 还没补够：慢滚下一帧接着来；快划等停下来再说（一路催就是一路卡）
    if (fast) { scheduleViewportCheckLater(st); } else { scheduleViewportCheck(st); }
  }

  /** 等一下再看（划得快的时候用：停下来之后由它把没补的补上）。 */
  function scheduleViewportCheckLater(st) {
    if (st.viewTimer) { return; }
    st.viewTimer = setTimeout(() => {
      st.viewTimer = 0;
      scheduleViewportCheck(st);
    }, FAST_SCROLL_GRACE_MS);
  }

  /** 攒到下一帧再量（滚动事件一帧能来好几个，每次都量版面就白花了）。 */
  function scheduleViewportCheck(st) {
    if (st.viewRaf) { return; }
    st.viewRaf = requestAnimationFrame(() => syncViewport(st));
  }

  function removeSession(id) {
    const st = sessions.get(id);
    if (!st) { return; }
    unkeep(st);
    cancelFlush(st);
    if (st.viewRaf) { cancelAnimationFrame(st.viewRaf); st.viewRaf = 0; }
    if (st.viewTimer) { clearTimeout(st.viewTimer); st.viewTimer = 0; }
    if (st.lerpRafId) { cancelAnimationFrame(st.lerpRafId); }
    dropRunningLine(st);   // 那条「正在跑」的定时器与耗时那只钟（见 startRunClock）一并停掉
    for (const tg of st.pendingToolTags.values()) { clearInterval(tg._timer); }
    st.viewEl.remove();
    sessions.delete(id);
    sessionDrafts.delete(id);
    if (activeId === id) { activeId = null; syncJumpBottom(st); syncComposerButtons(); }
  }

  // ==================== 工具调用耗时（侧边栏底部那颗「统计」）====================
  // 这个会话里每个工具调了几次、总共花了多久，以及花得最久的那几次调用。
  // 数从哪来：后端在每次工具结束时就算好了这一条跑了多久（src/editTracker.ts），随结果一起发过来
  // （toolResult / editCardResult 的 durationMs）——工具标签上不写它，都汇总到这张弹窗里看。
  // 所以只算这次打开页面之后真跑过的调用：刷新 / 重连后重放的历史不带这个数，统计从零重来。
  const TOOL_STATS_SLOWEST = 6;   // 「最慢的几次」最多列几条
  // 「最慢的几次」里点开看全文的那几条（键 = 工具名 + 那一行的文字）：弹窗开着时又来结果会重画一遍，
  // 重画后要保持原样开着。存着不清，下回再打开还是展开——反正点一下就能收起。
  const toolStatsExpanded = new Set();
  const toolStatsOverlay = document.getElementById("toolStatsOverlay");
  const toolStatsBody = document.getElementById("toolStatsBody");
  const toolStatsCloseBtn = document.getElementById("toolStatsClose");

  function toolStatsOpen() {
    return !!toolStatsOverlay && !toolStatsOverlay.classList.contains("hidden");
  }

  /** 记一笔：这个会话里某条工具调用跑完了，用了多久（durationMs 不在就不记：历史重放、被中断的都没这个数）。
   *  text 是这条调用在提示框里写的那一行（bash 就是「$ 命令」），「最慢的几次」直接拿它给人看。 */
  function noteToolDuration(st, toolName, text, durationMs) {
    if (!st || typeof durationMs !== "number" || !isFinite(durationMs) || durationMs < 0) { return; }
    const stats = st.toolStats;
    const name = toolName || "?";
    const row = stats.byTool.get(name) || { count: 0, totalMs: 0, maxMs: 0 };
    row.count += 1;
    row.totalMs += durationMs;
    row.maxMs = Math.max(row.maxMs, durationMs);
    stats.byTool.set(name, row);
    stats.calls += 1;
    stats.totalMs += durationMs;
    stats.slowest.push({ name, text: text || name, durationMs });
    stats.slowest.sort((a, b) => b.durationMs - a.durationMs);
    if (stats.slowest.length > TOOL_STATS_SLOWEST) { stats.slowest.length = TOOL_STATS_SLOWEST; }
    if (toolStatsOpen()) { renderToolStats(); }   // 弹窗开着就跟着长（每次调用完重画一次，几条几行的量）
  }

  function tsBlock(className, text) {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  }

  /** 统计表里的一行：cells 是 [{ text, cls }]，排成一排（表头与数据行同一套宽度）。 */
  function tsRowEl(cells, head) {
    const row = document.createElement("div");
    row.className = "ts-row" + (head ? " ts-row-head" : "");
    for (const it of cells) {
      const el = document.createElement("span");
      el.className = it.cls;
      el.textContent = it.text;
      row.appendChild(el);
    }
    return row;
  }

  /** 画一遍统计弹窗的内容：上面一句汇总（一共几次 / 合计多久），下面按工具名一张表，
   *  再下面是花得最久的那几次调用（工具名 + 那次在干什么 + 耗时）。
   *  那些“刷新页面就从头再算”“并行跑的几条各算各的”写在弹窗标题的悬停提示里（见 renderHtml 的 toolStatsTitle），
   *  不在正文里另占几行小字。 */
  function renderToolStats() {
    if (!toolStatsBody) { return; }
    toolStatsBody.innerHTML = "";
    toolStatsBody.scrollTop = 0;
    const st = activeSession();
    if (!st) {
      toolStatsBody.appendChild(tsBlock("ts-empty", "还没有会话。"));
      return;
    }
    const stats = st.toolStats;
    if (!stats.calls) {
      toolStatsBody.appendChild(tsBlock("ts-empty", "还没跑过工具调用。"));
      return;
    }
    toolStatsBody.appendChild(tsBlock("ts-summary",
      "共 " + stats.calls + " 次调用 · 合计 " + formatElapsed(stats.totalMs)));
    // 按工具名：合计时间长的排前面（看着就知道时间花在哪了）
    const rows = Array.from(stats.byTool.entries())
      .map(([name, v]) => ({ name, count: v.count, totalMs: v.totalMs, maxMs: v.maxMs }))
      .sort((a, b) => b.totalMs - a.totalMs);
    toolStatsBody.appendChild(tsRowEl([
      { text: "工具", cls: "ts-name" },
      { text: "次数", cls: "ts-num ts-count" },
      { text: "合计", cls: "ts-num" },
      { text: "平均", cls: "ts-num" },
      { text: "最长", cls: "ts-num" },
    ], true));
    for (const r of rows) {
      toolStatsBody.appendChild(tsRowEl([
        { text: r.name, cls: "ts-name" },
        { text: r.count + " 次", cls: "ts-num ts-count" },
        { text: formatElapsed(r.totalMs), cls: "ts-num" },
        { text: formatElapsed(r.totalMs / r.count), cls: "ts-num" },
        { text: formatElapsed(r.maxMs), cls: "ts-num" },
      ]));
    }
    toolStatsBody.appendChild(tsBlock("ts-section", "最慢的 " + stats.slowest.length + " 次"));
    for (const c of stats.slowest) {
      const row = tsRowEl([
        { text: c.name, cls: "ts-name" },
        { text: c.text || c.name, cls: "ts-text" },
        { text: formatElapsed(c.durationMs), cls: "ts-num" },
      ]);
      // 长命令 / 长参数一行放不下就截成 …（.ts-text 的省略号）；点这一条展开成多行看全，再点收起。
      // 电脑上鼠标停上去也能直接看（title 里是全文）。
      const key = c.name + "\u0000" + (c.text || c.name);
      row.classList.add("ts-call");
      row.title = c.text || c.name;
      if (toolStatsExpanded.has(key)) { row.classList.add("open"); }
      row.addEventListener("click", () => {
        if (row.classList.toggle("open")) { toolStatsExpanded.add(key); } else { toolStatsExpanded.delete(key); }
      });
      toolStatsBody.appendChild(row);
    }
  }

  function openToolStats() {
    if (!toolStatsOverlay) { return; }
    renderToolStats();
    toolStatsOverlay.classList.remove("hidden");
  }
  function closeToolStats() {
    if (toolStatsOverlay) { toolStatsOverlay.classList.add("hidden"); }
  }
  if (toolStatsOverlay) {
    // 点外面收起来；右上角那颗叉同理
    toolStatsOverlay.addEventListener("click", (e) => { if (e.target === toolStatsOverlay) { closeToolStats(); } });
    if (toolStatsCloseBtn) { toolStatsCloseBtn.addEventListener("click", closeToolStats); }
    // Esc 收起来：捕获阶段就地处掉，别让它顺手中止正在生成的那一轮（跟别的浮层一个道理）
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !toolStatsOpen()) { return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      closeToolStats();
    });
  }

  // ==================== 工具 / 技能 / MCP（侧边栏底部那颗「工具」）====================
  // 这个会话现在加载着什么：工具（来自内置还是哪个文件、现在生不生效）、技能（来自哪个文件）、
  // MCP 服务器（配了哪几个、停用了没有、真挂上来几个工具）。
  // 清单不归界面算：pi 里那个报清单的扩展取好（见 src/envBridgeSource.ts），写成一行暗号从 stderr
  // 交回后端，后端存着最近一份推过来（见 sessionRuntime 的 noteEnvSnapshot）。
  // 所以这里只做两件事：点开时要一份；来了就画。
  const envOverlay = document.getElementById("envOverlay");
  const envBody = document.getElementById("envBody");
  const envCloseBtn = document.getElementById("envClose");
  /** 最近收到的那一份清单，以及它是哪个会话的。 */
  let envSnapshot = null;
  let envSnapshotFor = "";
  /** 要过一份、还没回来。 */
  let envWaiting = false;

  function envOpen() {
    return !!envOverlay && !envOverlay.classList.contains("hidden");
  }

  /** 路径缩一下：只留最后几段（全路径放悬停提示里）。 */
  function envShortPath(path) {
    const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 3) { return String(path || ""); }
    return "…/" + parts.slice(-3).join("/");
  }

  /** 一行「来源」：内置 / 用户级 · …/pichat/ask-bridge-0.1.0.ts。 */
  function envSourceText(item) {
    const path = (item && item.path) || "";
    if (path.indexOf("builtin:") === 0) { return "内置"; }
    const scopes = { user: "用户级", project: "项目级", temporary: "临时" };
    const scope = scopes[(item && item.scope) || ""] || "";
    if (!path || path.charAt(0) === "<") { return scope || "扩展"; }
    const short = envShortPath(path);
    return scope ? scope + " · " + short : short;
  }

  /** 一个工具现在怎么给模型用：一句话。 */
  function envToolState(tool) {
    if (tool && tool.on) { return "生效"; }
    const exposure = (tool && tool.exposure) || "";
    if (exposure === "hidden") { return "用不了"; }
    if (exposure === "codemode") { return "要从脚本里调"; }
    if (exposure === "deferred") { return "要先被搜出来"; }
    return "没生效";
  }

  /** 清单里的一行：名字 / 状态 / 来源（放不下的用省略号，全在悬停提示里）。 */
  function envRowEl(name, state, source, on, title) {
    const row = document.createElement("div");
    row.className = "ts-row";
    const nameEl = document.createElement("span");
    nameEl.className = "env-name";
    nameEl.textContent = name;
    const stateEl = document.createElement("span");
    stateEl.className = "env-state" + (on ? " env-on" : "");
    stateEl.textContent = state;
    const sourceEl = document.createElement("span");
    sourceEl.className = "env-source";
    sourceEl.textContent = source || "";
    row.appendChild(nameEl);
    row.appendChild(stateEl);
    row.appendChild(sourceEl);
    if (title) { row.title = title; }
    return row;
  }

  /** 画一遍「加载了什么」：工具 / 技能 / MCP 三节，每节标题后面写着这一节有几个。
   *  清单是怎么来的、MCP 只认得出什么，写在弹窗标题的悬停提示里（见 renderHtml 的 envTitle）。 */
  function renderEnv() {
    if (!envBody) { return; }
    envBody.innerHTML = "";
    envBody.scrollTop = 0;
    const st = activeSession();
    if (!st) {
      envBody.appendChild(tsBlock("ts-empty", "还没有会话。"));
      return;
    }
    const env = (envSnapshot && envSnapshotFor === st.id) ? envSnapshot : null;
    if (!env) {
      envBody.appendChild(tsBlock("ts-empty", envWaiting ? "正在取…" : "还没取到，过一会儿再点一次。"));
      return;
    }
    const tools = Array.isArray(env.tools) ? env.tools : [];
    const skills = Array.isArray(env.skills) ? env.skills : [];
    const servers = Array.isArray(env.mcp) ? env.mcp : [];
    // MCP 挂上来的工具名都是 mcp__服务器__工具：它们不重列在「工具」那一节里
    // （一台服务器就能挂几十个，会把别的工具顶到屏外去），要看看下面 MCP 那一节。
    const isMcpTool = (it) => !!it && typeof it.name === "string" && it.name.indexOf("mcp__") === 0;
    const plainTools = tools.filter((it) => !isMcpTool(it));
    const mcpToolCount = tools.length - plainTools.length;
    const onCount = plainTools.filter((it) => it && it.on).length;

    // 工具（按名字排）
    envBody.appendChild(tsBlock("ts-section",
      "工具 " + plainTools.length + " 个" + (onCount ? " · " + onCount + " 个生效" : "")));
    plainTools.slice()
      .sort((a, b) => String(a && a.name || "").localeCompare(String(b && b.name || "")))
      .forEach((tool) => {
        envBody.appendChild(envRowEl(
          tool.name || "?",
          envToolState(tool),
          envSourceText(tool),
          !!tool.on,
          [(tool.path || ""), tool.exposure ? "怎么用：" + tool.exposure : ""].filter(Boolean).join("\n")));
      });

    // 技能
    envBody.appendChild(tsBlock("ts-section", "技能 " + skills.length + " 个"));
    skills.slice()
      .sort((a, b) => String(a && a.name || "").localeCompare(String(b && b.name || "")))
      .forEach((skill) => {
        envBody.appendChild(envRowEl(skill.name || "?", "", envSourceText(skill), false, skill.path || ""));
      });

    // MCP
    envBody.appendChild(tsBlock("ts-section",
      "MCP " + servers.length + " 个" + (mcpToolCount > 0 ? " · " + mcpToolCount + " 个工具" : "")));
    servers.slice()
      .sort((a, b) => String(a && a.name || "").localeCompare(String(b && b.name || "")))
      .forEach((server) => {
        let state = "没有工具";
        if (server.error) { state = "读不懂"; }
        else if (server.enabled === false) { state = "已停用"; }
        else if (server.tools > 0) { state = "连上了 · " + server.tools + " 个工具"; }
        // 配置读不懂那一条：名字那格是「配置有错」，错在哪儿写来源里（悬停能看全文）
        const source = server.error ? String(server.error) : envSourceText(server);
        envBody.appendChild(envRowEl(server.name || "?", state, source, server.tools > 0, server.error || server.path || ""));
      });
  }

  /** 现要一份清单（后端存着最近一次报上来的，可能比手上这份新）。 */
  function requestEnv() {
    envSnapshot = null;
    envSnapshotFor = "";
    envWaiting = true;
    renderEnv();
    vscode.postMessage({ type: "requestEnvInfo", sessionId: activeId || "" });
  }

  function openEnv() {
    if (!envOverlay) { return; }
    envOverlay.classList.remove("hidden");
    requestEnv();
  }

  function closeEnv() {
    if (envOverlay) { envOverlay.classList.add("hidden"); }
  }

  if (envOverlay) {
    // 点外面收起来；右上角那颗叉同理
    envOverlay.addEventListener("click", (e) => { if (e.target === envOverlay) { closeEnv(); } });
    if (envCloseBtn) { envCloseBtn.addEventListener("click", closeEnv); }
    // Esc 收起来：跟别的浮层一样在捕获阶段就地处掉，别顺手中止正在生成的那一轮
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !envOpen()) { return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      closeEnv();
    });
  }

  // ==================== 设置浮层（插件选项）====================
  // 模型（models.json）从这里撤了：那是 pi 自己的配置，插件不再读写它，界面上也不再出现。
  const settingsOverlay = document.getElementById("settingsOverlay");
  let viewOptionItems = [];
  /** 「重启后端」那行说明的那个元素（后端回话时改它）；没画出这一行时是 null。 */
  let restartNoteEl = null;
  const viewOptsRoot = document.getElementById("viewOptsRoot");

  function renderViewOpts() {
    viewOptsRoot.innerHTML = "";
    restartNoteEl = null;
    if (!viewOptionItems.length) {
      const empty = document.createElement("div"); empty.className = "vo-empty"; empty.textContent = "没有可配置项";
      viewOptsRoot.appendChild(empty); return;
    }
    viewOptionItems.forEach((it) => {
      const row = document.createElement("div"); row.className = "vo-item";
      if (it.kind === "slider") { renderSliderRow(row, it); viewOptsRoot.appendChild(row); return; }
      if (it.kind === "button") { renderButtonRow(row, it); viewOptsRoot.appendChild(row); return; }
      if (it.kind === "text") { renderTextRow(row, it); viewOptsRoot.appendChild(row); return; }
      if (it.kind === "weixin") { renderWeixinRow(row, it); viewOptsRoot.appendChild(row); return; }
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
        const desc = it.desc || "";
        if (desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = desc; txt.appendChild(d); }
        row.appendChild(check); row.appendChild(txt);
        row.addEventListener("click", () => {
          vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: it.value });
        });
      }
      viewOptsRoot.appendChild(row);
    });
  }

  /**
   * 「微信」那一块：扫码登录（后端在 chatHost.ts 的 weixinOptionItem 里给这几项）。
   *
   * 二维码是现画的（media/qrcode.js）：页面只许连本站，不能引外站的图。
   * 走到哪一步全看后端给的 phase —— 界面这边不猜，也不记着自己那份：
   * 每次登录状态一变，后端就把整份选项重推一遍（见 chatHost.ts 的 weixinLogin）。
   */
  function renderWeixinRow(row, it) {
    row.classList.add("vo-item-weixin");
    const txt = document.createElement("div"); txt.className = "vo-text";
    const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "微信";
    txt.appendChild(label);
    row.appendChild(txt);

    const body = document.createElement("div"); body.className = "vo-wx-body";
    row.appendChild(body);

    const phase = String(it.phase || "idle");
    const message = String(it.message || "");
    // 正在扫的时候这块得看得见：设置那一列挺长，它本来可能半截在框外（人点了“扫码登录”总得看到码）
    if (phase === "wait" || phase === "scaned" || phase === "needcode") {
      setTimeout(() => { try { row.scrollIntoView({ block: "nearest" }); } catch (e) { /* 滚不动就算了 */ } }, 0);
    }

    function note(text, isError) {
      if (!text) { return; }
      const el = document.createElement("div");
      el.className = "vo-wx-note" + (isError ? " error" : "");
      el.textContent = text;
      body.appendChild(el);
    }
    function button(text, onClick, primary) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "vo-btn"; btn.textContent = text;
      if (primary) { btn.style.background = "var(--vscode-button-background, #007acc)"; btn.style.color = "var(--vscode-button-foreground, #fff)"; }
      btn.addEventListener("click", onClick);
      return btn;
    }

    if (phase === "done") {
      const who = document.createElement("div"); who.className = "vo-wx-account";
      who.textContent = it.account ? ("已登录：" + it.account) : "已登录";
      body.appendChild(who);
      note(message);
      // 再扫一张：换了微信、或者以后令牌过期了，得能重新绑一次（不用去删文件）
      const line = document.createElement("div"); line.className = "vo-wx-row";
      line.appendChild(button("重新扫码", () => {
        vscode.postMessage({ type: "weixinLogin", action: "start" });
      }));
      body.appendChild(line);
      return;
    }

    if (phase === "wait" || phase === "scaned" || phase === "needcode") {
      const qrBox = document.createElement("div"); qrBox.className = "vo-wx-qr";
      const canvas = document.createElement("canvas");
      qrBox.appendChild(canvas);
      body.appendChild(qrBox);
      if (!drawQrInto(canvas, String(it.qr || ""))) {
        qrBox.remove();
        note("二维码画不出来（这页的二维码库没加载上）", true);
        if (it.qr) {
          const link = document.createElement("div"); link.className = "vo-wx-link"; link.textContent = String(it.qr);
          body.appendChild(link);
        }
      }
      note(message, false);
      if (phase === "needcode") {
        const line = document.createElement("div"); line.className = "vo-wx-row";
        const input = document.createElement("input");
        input.type = "text"; input.className = "vo-input vo-wx-code"; input.spellcheck = false;
        input.placeholder = "手机上的数字";
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); submit(); }
        });
        function submit() { vscode.postMessage({ type: "weixinLogin", action: "code", code: input.value }); }
        line.appendChild(input);
        line.appendChild(button("确定", submit, true));
        body.appendChild(line);
        setTimeout(() => input.focus(), 0);
        return;
      }
      const line = document.createElement("div"); line.className = "vo-wx-row";
      line.appendChild(button("取消", () => { vscode.postMessage({ type: "weixinLogin", action: "cancel" }); }));
      body.appendChild(line);
      return;
    }

    // idle / error：一颗按钮重来
    note(message || "扫一下就把这台后端绑到你的微信上", phase === "error");
    const line = document.createElement("div"); line.className = "vo-wx-row";
    line.appendChild(button(phase === "error" ? "再试一次" : "扫码登录", () => {
      vscode.postMessage({ type: "weixinLogin", action: "start" });
    }, true));
    body.appendChild(line);
  }

  /**
   * 把一串字画成二维码（media/qrcode.js 那个库的矩阵，自己一格一格画到 canvas 上）。
   * @returns 画成了没有（库没加载上 / 没字就是 false）
   */
  function drawQrInto(canvas, text) {
    if (!text || typeof qrcode !== "function") { return false; }
    let qr;
    try {
      qr = qrcode(0, "M");          // 0 = 按内容挑最小的版本
      qr.addData(text, "Byte");
      qr.make();
    } catch (e) { return false; }
    const count = qr.getModuleCount();
    const cell = 5;                  // 每个小格几像素（配合下面最多 260px 的宽度自己缩）
    const quiet = 2;                 // 四周留的静区（格数）：留窄了手机认不出来
    const side = (count + quiet * 2) * cell;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);
    // 大码别撑破这块地方：按 260px 折算成缩放后的显示尺寸（画布本身仍是清楚的）
    const shown = Math.min(side, 260);
    canvas.style.width = shown + "px";
    canvas.style.height = shown + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) { return false; }
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    const unit = cell * dpr;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c)) { continue; }
        ctx.fillRect(Math.round((c + quiet) * unit), Math.round((r + quiet) * unit), Math.ceil(unit), Math.ceil(unit));
      }
    }
    return true;
  }

  /**
   * 「重启后端」那一行：说明 + 右边一颗按钮。
   * 点下去先在本地说一句「正在编译并重启」——后端 0.5 秒后就退，它顶多再回一句话（restartStatus）。
   */
  function renderButtonRow(row, it) {
    row.classList.add("vo-item-button");
    const txt = document.createElement("div"); txt.className = "vo-text";
    const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
    txt.appendChild(label);
    const note = document.createElement("div"); note.className = "vo-desc"; note.textContent = it.desc || "";
    txt.appendChild(note);
    row.appendChild(txt);
    if (it.action === "restartBackend") { restartNoteEl = note; }
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "vo-btn";
    btn.textContent = it.button || "执行";
    btn.disabled = it.disabled === true;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      note.textContent = "正在编译并重启…这个页面过一会儿会自己连回来。";
      vscode.postMessage({ type: "restartBackend" });
    });
    row.appendChild(btn);
  }

  /**
   * 填字那一行（地址、名字这种）：说明在上面，框占满下面一行。
   * 填完（回车 / 点别处）才发出去；Esc 是反悔，恢复成原来的值。
   */
  function renderTextRow(row, it) {
    row.classList.add("vo-item-text");
    const txt = document.createElement("div"); txt.className = "vo-text";
    const label = document.createElement("div"); label.className = "vo-label"; label.textContent = it.label || "";
    txt.appendChild(label);
    if (it.desc) { const d = document.createElement("div"); d.className = "vo-desc"; d.textContent = it.desc; txt.appendChild(d); }
    row.appendChild(txt);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "vo-input";
    input.spellcheck = false;
    input.value = it.value || "";
    if (it.placeholder) { input.placeholder = it.placeholder; }
    // 在设置里打字就是打字：别让这些键冒出去触发“发送”“切会话”“收起浮层”那些
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); input.value = it.value || ""; input.blur(); }
    });
    input.addEventListener("change", () => {
      vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: input.value });
    });
    row.appendChild(input);
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
    // 「跟随 VSCode」紧跟在数值后面（跟它管的那根滑块同一行）：
    // 原来是行里的另一个孩子，column 布局会把它拉成整行宽的一条。
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "vo-slider-reset";
    reset.textContent = "跟随 VSCode";
    reset.addEventListener("click", () => {
      vscode.postMessage({ type: "pickerToggle", kind: "options", action: it.action, value: "" });
    });
    ctrl.appendChild(reset);
    row.appendChild(ctrl);
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
  activateSessionFromUrl();
})();
