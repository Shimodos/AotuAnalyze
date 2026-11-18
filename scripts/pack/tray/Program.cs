// Значок Viarde Tracker в области уведомлений.
//
// Запускает сервер трекера без окна терминала, открывает доску в браузере и
// останавливает сервер при выходе.
//
// Собирается компилятором C#, который есть в самой Windows
// (Microsoft.NET\Framework64\v4.0.30319\csc.exe), под .NET Framework 4.x —
// он установлен в Windows 10 и 11 из коробки, ставить ничего не нужно.
// Поэтому синтаксис здесь — C# 5: без интерполяции строк, «?.» и «out var».
//
//   ViardeTracker.exe            запустить и открыть доску
//   ViardeTracker.exe --silent   запустить, доску не открывать (автозапуск)
//   ViardeTracker.exe --quit     попросить запущенный экземпляр выйти
//
// Повторный запуск не плодит второй сервер: он просит первый экземпляр
// открыть доску и завершается.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ViardeTracker
{
    internal static class Program
    {
        private const string MutexName = "ViardeTracker.Tray.Running";
        internal const string QuitEventName = "ViardeTracker.Tray.Quit";
        internal const string ShowEventName = "ViardeTracker.Tray.Show";

        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = Array.IndexOf(args, "--silent") >= 0;
            bool quit = Array.IndexOf(args, "--quit") >= 0;

            bool first;
            using (Mutex mutex = new Mutex(true, MutexName, out first))
            {
                if (!first)
                {
                    Signal(quit ? QuitEventName : ShowEventName);
                    return 0;
                }
                if (quit) return 0;

                Application.EnableVisualStyles();
                using (TrayContext context = new TrayContext(silent))
                {
                    if (context.Ready) Application.Run(context);
                }
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        private static void Signal(string name)
        {
            try
            {
                using (EventWaitHandle handle = EventWaitHandle.OpenExisting(name))
                {
                    handle.Set();
                }
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // первый экземпляр как раз завершается — сигналить некому
            }
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        private const string Title = "Viarde Tracker";

        private readonly string appDir;
        private readonly string dataDir;
        private readonly string logPath;
        private readonly int port;
        private readonly object logLock = new object();

        private NotifyIcon icon;
        private Control invoker;
        private EventWaitHandle quitEvent;
        private EventWaitHandle showEvent;
        private Process server;
        private StreamWriter log;
        private bool exiting;

        public bool Ready { get; private set; }

        public TrayContext(bool silent)
        {
            appDir = Path.GetDirectoryName(Application.ExecutablePath);

            // Те же правила, что в start.cjs: заданное снаружи не перекрываем
            string dataEnv = Environment.GetEnvironmentVariable("VIARDE_DATA_DIR");
            dataDir = string.IsNullOrEmpty(dataEnv)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ViardeTracker")
                : dataEnv;
            Directory.CreateDirectory(dataDir);
            logPath = Path.Combine(dataDir, "server.log");

            int parsed;
            port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out parsed) ? parsed : 3000;

            string node = Path.Combine(appDir, "node", "node.exe");
            string start = Path.Combine(appDir, "start.cjs");
            if (!File.Exists(node) || !File.Exists(start))
            {
                MessageBox.Show(
                    "Не знайдено файли програми поруч із " + Path.GetFileName(Application.ExecutablePath) + ".\n" + appDir,
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            // Скрытый элемент управления — чтобы из фоновых потоков вернуться в поток окна
            invoker = new Control();
            IntPtr handle = invoker.Handle;
            GC.KeepAlive(handle);

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Відкрити дошку", null, delegate { OpenBoard(); });
            menu.Items.Add("Тека даних і журнал", null, delegate { OpenFolder(dataDir); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Вихід", null, delegate { ExitApp(); });

            icon = new NotifyIcon();
            icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon.Text = Title;
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenBoard(); };
            icon.Visible = true;

            quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
            ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate { OnUi(ExitApp); }, null, -1, false);
            ThreadPool.RegisterWaitForSingleObject(showEvent, delegate { OnUi(OpenBoard); }, null, -1, false);

            StartServer(node, start);
            Ready = true;

            if (!silent)
            {
                Thread opener = new Thread(delegate ()
                {
                    if (WaitUntilUp(40)) OnUi(OpenBoard);
                });
                opener.IsBackground = true;
                opener.Start();
            }
        }

        private void OnUi(MethodInvoker action)
        {
            if (exiting || invoker == null || invoker.IsDisposed) return;
            try
            {
                invoker.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // окно уже закрывается
            }
        }

        private void StartServer(string node, string start)
        {
            // Журнал сервера каждый запуск начинаем заново: он нужен, чтобы понять,
            // почему программа не поднялась, а не как история
            log = new StreamWriter(logPath, false, new UTF8Encoding(false));
            log.AutoFlush = true;
            log.WriteLine("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] запуск, порт " + port);

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.Arguments = "\"" + start + "\"";
            info.WorkingDirectory = appDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;

            server = new Process();
            server.StartInfo = info;
            server.EnableRaisingEvents = true;
            server.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
            server.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
            server.Exited += delegate { OnUi(ServerStopped); };
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
        }

        private void WriteLog(string line)
        {
            if (line == null) return;
            lock (logLock)
            {
                if (log != null) log.WriteLine(line);
            }
        }

        /// Сервер завершился сам — обычно порт занят другой программой
        private void ServerStopped()
        {
            if (exiting) return;
            icon.ShowBalloonTip(
                10000, Title,
                "Сервер зупинився. Причина — у журналі: " + logPath,
                ToolTipIcon.Warning);
        }

        private bool IsUp()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/dropbox/status");
                request.Timeout = 2000;
                request.Proxy = null;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch (WebException)
            {
                return false;
            }
        }

        private bool WaitUntilUp(int seconds)
        {
            for (int i = 0; i < seconds * 2; i++)
            {
                if (exiting) return false;
                if (IsUp()) return true;
                Thread.Sleep(500);
            }
            return false;
        }

        private void OpenBoard()
        {
            // localhost, а не 127.0.0.1: на этот адрес Dropbox возвращает после входа,
            // и cookie входа должна быть выставлена на том же имени
            try
            {
                Process.Start("http://localhost:" + port + "/");
            }
            catch (Exception error)
            {
                MessageBox.Show("Не вдалося відкрити браузер: " + error.Message, Title);
            }
        }

        private static void OpenFolder(string dir)
        {
            try
            {
                Process.Start("explorer.exe", "\"" + dir + "\"");
            }
            catch (Exception)
            {
                // проводник не открылся — не повод ронять значок
            }
        }

        private void ExitApp()
        {
            if (exiting) return;
            exiting = true;
            StopServer();
            if (icon != null) icon.Visible = false;
            ExitThread();
        }

        /// Сервер и его скан: taskkill /T снимает всё дерево процессов
        private void StopServer()
        {
            try
            {
                if (server != null && !server.HasExited)
                {
                    ProcessStartInfo kill = new ProcessStartInfo("taskkill.exe", "/PID " + server.Id + " /T /F");
                    kill.UseShellExecute = false;
                    kill.CreateNoWindow = true;
                    using (Process killer = Process.Start(kill))
                    {
                        killer.WaitForExit(5000);
                    }
                    server.WaitForExit(5000);
                }
            }
            catch (Exception)
            {
                // процесс уже завершился сам
            }

            lock (logLock)
            {
                if (log != null)
                {
                    log.WriteLine("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] выход");
                    log.Dispose();
                    log = null;
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (!exiting)
                {
                    exiting = true;
                    StopServer();
                }
                if (icon != null) icon.Dispose();
                if (invoker != null) invoker.Dispose();
                if (quitEvent != null) quitEvent.Dispose();
                if (showEvent != null) showEvent.Dispose();
                if (server != null) server.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
