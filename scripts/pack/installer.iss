; Установщик Viarde Tracker (Inno Setup 6).
;
; Собирается из готовой папки dist\ViardeTracker, которую делает scripts\pack.mjs;
; тот же скрипт и вызывает компилятор, если Inno Setup установлен:
;   ISCC.exe /DAppVersion=0.1.0 /DSourceDir=...\dist\ViardeTracker /DOutputDir=...\dist installer.iss
;
; Ставится в профиль пользователя, без прав администратора: программа только
; читает Dropbox по сети и держит свою базу в %LOCALAPPDATA%\ViardeTracker.
; Эту папку удаление программы не трогает — в ней история проектов.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\ViardeTracker"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

[Setup]
; AppId не менять: по нему новая версия находит и заменяет старую
AppId={{6B0E5C1E-6C0B-4E0F-9C55-7A2B6C1D3F41}
AppName=Viarde Tracker
AppVersion={#AppVersion}
AppPublisher=Viarde Studio
DefaultDirName={autopf}\Viarde Tracker
DefaultGroupName=Viarde Tracker
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=ViardeTrackerSetup-{#AppVersion}
SetupIconFile={#SourceDir}\tracker.ico
UninstallDisplayIcon={app}\ViardeTracker.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Запущенную программу останавливаем сами (см. [Code]) — её значок не окно,
; и штатное «закрыть приложения» установщика до сервера не дотянется
CloseApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "uk"; MessagesFile: "compiler:Languages\Ukrainian.isl"
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[CustomMessages]
en.Autostart=Start with Windows (changes are recorded only while the tracker is running)
uk.Autostart=Запускати разом із Windows (зміни фіксуються лише поки трекер працює)
ru.Autostart=Запускать вместе с Windows (изменения фиксируются, только пока трекер работает)
en.Launch=Start Viarde Tracker
uk.Launch=Запустити Viarde Tracker
ru.Launch=Запустить Viarde Tracker

[Tasks]
Name: "autostart"; Description: "{cm:Autostart}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Viarde Tracker"; Filename: "{app}\ViardeTracker.exe"
; --silent: при входе в Windows значок появляется, а браузер сам не открывается
Name: "{userstartup}\Viarde Tracker"; Filename: "{app}\ViardeTracker.exe"; Parameters: "--silent"; Tasks: autostart

[Run]
Filename: "{app}\ViardeTracker.exe"; Description: "{cm:Launch}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Иначе файлы сервера заняты и удалятся не все
Filename: "{app}\ViardeTracker.exe"; Parameters: "--quit"; RunOnceId: "QuitTray"; Flags: runhidden

[Code]
// Обновление поверх работающей программы: просим её выйти и ждём, пока
// сервер отпустит файлы. --quit без запущенного экземпляра просто завершается.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Exe: String;
begin
  Exe := ExpandConstant('{app}\ViardeTracker.exe');
  if FileExists(Exe) then
  begin
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(3000);
  end;
  Result := '';
end;
