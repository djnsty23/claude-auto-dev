# toast.ps1 — one Windows notification, no third-party module.
#
# BurntToast is not installed on this machine and requiring it would make the
# notifier fail closed on a fresh install. The WinRT path below ships with
# Windows, so it works out of the box.
#
# Args are passed with -File so nothing has to survive a quoting round-trip
# between Node, cmd and PowerShell — the trap that eats one backslash level.

param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Body
)

$ErrorActionPreference = 'Stop'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)

# CreateTextNode escapes the content, so a question containing & or < cannot
# break the toast XML. Do not build this string by hand.
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
$texts.Item(1).AppendChild($template.CreateTextNode($Body)) | Out-Null

# Toasts require a registered AppID. PowerShell's own is present on every
# Windows install, which keeps this dependency-free.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($template))
