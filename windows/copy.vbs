' Claude Code copy button: opened through the .ccopy file type with the path of
' a UTF-8 file holding one code block; puts that text on the clipboard, silently.
' Only .ccopy files in this script's own folder are copied, so a stray .ccopy
' file from anywhere else cannot replace the clipboard.
' clip.exe misreads UTF-8 and keeps a UTF-16 BOM, so it gets BOM-less UTF-16LE,
' through a temp file of its own so two quick clicks cannot mix.
If WScript.Arguments.Count = 0 Then WScript.Quit 1
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(WScript.Arguments(0)) Then WScript.Quit 1
src = fso.GetFile(WScript.Arguments(0)).Path
home = fso.GetFolder(fso.GetParentFolderName(WScript.ScriptFullName)).Path & "\"
If StrComp(Left(src, Len(home)), home, vbTextCompare) <> 0 Then WScript.Quit 2
If LCase(fso.GetExtensionName(src)) <> "ccopy" Then WScript.Quit 2
tmp = fso.BuildPath(home, fso.GetTempName())
Set s = CreateObject("ADODB.Stream") : s.Type = 2 : s.Charset = "utf-8" : s.Open
s.LoadFromFile src : t = s.ReadText : s.Close
Set o = CreateObject("ADODB.Stream") : o.Type = 2 : o.Charset = "unicode" : o.Open
o.WriteText t : o.Position = 0 : o.Type = 1 : o.Position = 2 : d = o.Read : o.Close
Set w = CreateObject("ADODB.Stream") : w.Type = 1 : w.Open : w.Write d : w.SaveToFile tmp, 2 : w.Close
' cmd.exe and clip.exe by full path from the system folder, and cmd with /d,
' so neither the working folder, PATH nor cmd's AutoRun key can swap them.
sys = fso.GetSpecialFolder(1) & "\"
On Error Resume Next
CreateObject("WScript.Shell").Run """" & sys & "cmd.exe"" /d /c """"" & sys & "clip.exe"" < """ & tmp & """""", 0, True
fso.DeleteFile tmp, True
