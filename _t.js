function relativeTo(cwd, full) {
  const norm = (s) => s.replace(/\/g, "/");
  const c = norm(cwd).replace(/\/$/, "") + "/";
  const f = norm(full);
  if (f.toLowerCase().startsWith(c.toLowerCase())) return f.slice(c.length);
  return full;
}
console.log("同项目:", relativeTo("D:\BackUp\pi_plugin", "D:\BackUp\pi_plugin\src\extension.ts"));
console.log("外部:", relativeTo("D:\BackUp\pi_plugin", "D:\Other\file.txt"));
