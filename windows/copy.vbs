' Claude Code copy button: opened through the .ccopy file type with the path of
' a UTF-8 file holding one code block; puts that text on the clipboard, silently.
' clip.exe misreads UTF-8 and keeps a UTF-16 BOM, so it gets BOM-less UTF-16LE.
If WScript.Arguments.Count = 0 Then WScript.Quit 1
Set fso = CreateObject("Scripting.FileSystemObject")
tmp = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "clip.u16")
Set s = CreateObject("ADODB.Stream") : s.Type = 2 : s.Charset = "utf-8" : s.Open
s.LoadFromFile WScript.Arguments(0) : t = s.ReadText : s.Close
Set o = CreateObject("ADODB.Stream") : o.Type = 2 : o.Charset = "unicode" : o.Open
o.WriteText t : o.Position = 0 : o.Type = 1 : o.Position = 2 : d = o.Read : o.Close
Set w = CreateObject("ADODB.Stream") : w.Type = 1 : w.Open : w.Write d : w.SaveToFile tmp, 2 : w.Close
CreateObject("WScript.Shell").Run "cmd /c clip < """ & tmp & """", 0, True
