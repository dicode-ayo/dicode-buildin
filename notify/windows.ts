// The Windows delivery path for buildin/notify, kept out of task.ts so the
// command it spawns can be asserted without a Windows host to spawn it on.

export type Urgency = "low" | "normal" | "critical";

// ToolTipIcon enum value for NotifyIcon.ShowBalloonTip.
export function toWinIcon(urgency: Urgency): string {
  switch (urgency) {
    case "low":
      return "None";
    case "critical":
      return "Warning";
    default:
      return "Info";
  }
}

// windowsNotifyCommand builds the full argv for a balloon notification.
//
// System.Drawing supplies SystemIcons and is loaded explicitly: Windows
// PowerShell resolves it as a Forms dependency, pwsh does not.
export function windowsNotifyCommand(
  title: string,
  body: string,
  urgency: Urgency,
): string[] {
  // PowerShell escapes a single quote inside a single-quoted string by
  // doubling it; a backslash is not an escape character there.
  const esc = (s: string) => s.replace(/'/g, "''");
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$n = New-Object System.Windows.Forms.NotifyIcon;",
    "$n.Icon = [System.Drawing.SystemIcons]::Application;",
    "$n.Visible = $true;",
    `$n.ShowBalloonTip(5000, '${esc(title)}', '${
      esc(body)
    }', [System.Windows.Forms.ToolTipIcon]::${toWinIcon(urgency)});`,
    "Start-Sleep -Seconds 1;",
    "$n.Dispose()",
  ].join(" ");
  return ["powershell", "-NoProfile", "-Command", ps];
}
