' fleet-notify-hidden.vbs — run one notifier pass with no console window.
'
' A scheduled task firing every two minutes must not flash a console window at
' someone who is working. WScript.Shell.Run with intWindowStyle 0 launches
' hidden while STAYING IN THE INTERACTIVE SESSION, which matters: a task
' configured to run "whether the user is logged on or not" runs detached from
' the desktop and its toasts go nowhere.
'
' Arg 1: full path to node.exe
' Arg 2: full path to fleet-notify.js

Option Explicit

Dim shell, args, cmd
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 2 Then
    WScript.Quit 2
End If

cmd = """" & args(0) & """ """ & args(1) & """"

' 0 = hidden window, False = do not wait. The task's own timeout is the backstop.
shell.Run cmd, 0, False
WScript.Quit 0
