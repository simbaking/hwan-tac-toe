import java.awt.Desktop;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Sets up the runtime environment and launches the Hwan Tac Toe Node.js game
 * server on port 8086, opening Google Chrome automatically.
 */
public class GameStarter {

    private static final int PORT = 8086;
    private static final String GAME_DIR_NAME = "tic tac toe expand remove";
    private static final String SERVER_FILE_NAME = "server.js";
    private static final String GAME_URL = "http://localhost:" + PORT;
    private static final String HEALTH_URL = GAME_URL + "/api/state";
    private static final String NODE_VERSION = "22.12.0";

    private static final String OS_NAME = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    private static final boolean IS_WINDOWS = OS_NAME.contains("win");
    private static final boolean IS_MAC = OS_NAME.contains("mac");

    private static final Object SERVER_LOCK = new Object();
    private static volatile Process serverProcess;
    private static String nodePath;

    public static void main(String[] args) {
        boolean openBrowser = true;
        for (String arg : args) {
            if ("--no-browser".equalsIgnoreCase(arg)) {
                openBrowser = false;
            }
        }

        File projectRoot = resolveProjectRoot();
        if (projectRoot == null) {
            System.err.println("ERROR: Could not locate \"" + GAME_DIR_NAME + File.separator
                    + SERVER_FILE_NAME + "\" from working directory: " + System.getProperty("user.dir"));
            System.exit(1);
            return;
        }
        File gameDir = new File(projectRoot, GAME_DIR_NAME);

        System.out.println("==========================================");
        System.out.println("       Hwan Tac Toe - Game Starter");
        System.out.println("==========================================");
        System.out.println("OS:           " + System.getProperty("os.name") + " (" + System.getProperty("os.arch") + ")");
        System.out.println("Project Root: " + projectRoot.getAbsolutePath());
        System.out.println("Game Dir:     " + gameDir.getAbsolutePath());
        System.out.println("Game URL:     " + GAME_URL);
        System.out.println();

        registerShutdownHook();

        try {
            if (!ensureNodeInstalled(projectRoot)) {
                System.err.println("FATAL: Could not locate or install Node.js.");
                System.exit(1);
                return;
            }

            killExistingServerOnPort();
            startServer(gameDir);

            if (!waitForServerReady()) {
                System.err.println("FATAL: Server failed to respond at " + HEALTH_URL);
                stopManagedServer();
                System.exit(1);
                return;
            }

            System.out.println("  Server is ready at " + GAME_URL);
            if (openBrowser) {
                openGameInChrome();
            }

            runInteractiveLoop(gameDir);
        } catch (Exception e) {
            System.err.println("Error running GameStarter: " + e.getMessage());
            e.printStackTrace();
            stopManagedServer();
            System.exit(1);
        }
    }

    // ==================== Project & Runtime Resolution ====================

    private static File resolveProjectRoot() {
        File cwd = new File(System.getProperty("user.dir", ".")).getAbsoluteFile();
        File[] candidates = new File[] { cwd, cwd.getParentFile() };
        for (File candidate : candidates) {
            if (candidate == null) {
                continue;
            }
            File serverFile = new File(new File(candidate, GAME_DIR_NAME), SERVER_FILE_NAME);
            if (serverFile.isFile()) {
                return candidate;
            }
        }
        return null;
    }

    private static void registerShutdownHook() {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            stopManagedServer();
        }, "game-starter-shutdown"));
    }

    private static boolean ensureNodeInstalled(File projectRoot) {
        System.out.println("[1/3] Checking Node.js runtime...");

        String nodeDirName = getNodeDirName();
        File runtimeDir = new File(projectRoot, "node_runtime");
        File localNodeDir = new File(runtimeDir, nodeDirName);
        File localNode = new File(localNodeDir, IS_WINDOWS ? "node.exe" : "bin" + File.separator + "node");

        if (isUsableNode(localNode)) {
            nodePath = localNode.getAbsolutePath();
            System.out.println("  Found portable Node.js: " + nodePath);
            return true;
        }

        String pathNode = findNodeInPath();
        if (pathNode != null) {
            nodePath = pathNode;
            System.out.println("  Found Node.js in PATH: " + nodePath);
            return true;
        }

        for (File candidate : getKnownNodeCandidates()) {
            if (isUsableNode(candidate)) {
                nodePath = candidate.getAbsolutePath();
                System.out.println("  Found installed Node.js: " + nodePath);
                return true;
            }
        }

        System.out.println("  Node.js not found locally. Downloading Node.js v" + NODE_VERSION + "...");
        return downloadAndExtractNode(runtimeDir, localNodeDir);
    }

    private static List<File> getKnownNodeCandidates() {
        List<File> candidates = new ArrayList<>();
        String home = System.getProperty("user.home", "");

        if (IS_WINDOWS) {
            candidates.add(new File("C:\\Program Files\\nodejs\\node.exe"));
            String localAppData = System.getenv("LOCALAPPDATA");
            if (localAppData != null && !localAppData.isEmpty()) {
                candidates.add(new File(localAppData, "Programs\\nodejs\\node.exe"));
            }
            return candidates;
        }

        if (!home.isEmpty()) {
            File nvmDir = new File(home, ".nvm/versions/node");
            File[] versions = nvmDir.listFiles(File::isDirectory);
            if (versions != null) {
                Arrays.sort(versions, (a, b) -> compareSemverDesc(a.getName(), b.getName()));
                for (File verDir : versions) {
                    candidates.add(new File(verDir, "bin/node"));
                }
            }
        }

        candidates.add(new File("/opt/homebrew/bin/node"));
        candidates.add(new File("/usr/local/bin/node"));
        if (!home.isEmpty()) {
            candidates.add(new File(home, ".volta/bin/node"));
            candidates.add(new File(home, ".asdf/shims/node"));
            candidates.add(new File(home, ".fnm/current/bin/node"));
        }
        return candidates;
    }

    private static int compareSemverDesc(String a, String b) {
        int[] pa = parseSemverParts(a);
        int[] pb = parseSemverParts(b);
        for (int i = 0; i < 3; i++) {
            if (pa[i] != pb[i]) {
                return Integer.compare(pb[i], pa[i]);
            }
        }
        return b.compareTo(a);
    }

    private static int[] parseSemverParts(String name) {
        String clean = name.startsWith("v") || name.startsWith("V") ? name.substring(1) : name;
        String[] tokens = clean.split("\\.");
        int[] parts = new int[3];
        for (int i = 0; i < Math.min(3, tokens.length); i++) {
            String digits = tokens[i].replaceAll("[^0-9].*$", "");
            if (!digits.isEmpty()) {
                try {
                    parts[i] = Integer.parseInt(digits);
                } catch (NumberFormatException ignored) {
                    parts[i] = 0;
                }
            }
        }
        return parts;
    }

    private static String findNodeInPath() {
        try {
            ProcessBuilder pb = IS_WINDOWS
                    ? new ProcessBuilder("cmd.exe", "/c", "where", "node")
                    : new ProcessBuilder("which", "node");
            Process proc = pb.start();
            List<String> lines = readLines(proc.getInputStream());
            if (proc.waitFor() == 0 && !lines.isEmpty()) {
                String resolved = lines.get(0).trim();
                if (!resolved.isEmpty() && verifyNodeRuns(resolved)) {
                    return resolved;
                }
            }
        } catch (Exception ignored) {
            // Fall through to known install paths
        }
        return null;
    }

    private static boolean isUsableNode(File nodeFile) {
        if (nodeFile == null || !nodeFile.isFile()) {
            return false;
        }
        if (!IS_WINDOWS && !nodeFile.canExecute()) {
            return false;
        }
        return verifyNodeRuns(nodeFile.getAbsolutePath());
    }

    private static boolean verifyNodeRuns(String executable) {
        try {
            Process proc = new ProcessBuilder(executable, "-v")
                    .redirectErrorStream(true)
                    .start();
            readLines(proc.getInputStream());
            return proc.waitFor(5, TimeUnit.SECONDS) && proc.exitValue() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    // ==================== Portable Node.js Download ====================

    private static String getNodeDirName() {
        String arch = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
        boolean isArm = arch.contains("aarch64") || arch.contains("arm");

        if (IS_WINDOWS) {
            return "node-v" + NODE_VERSION + "-win-x64";
        }
        if (IS_MAC) {
            return "node-v" + NODE_VERSION + "-darwin-" + (isArm ? "arm64" : "x64");
        }
        return "node-v" + NODE_VERSION + "-linux-" + (isArm ? "arm64" : "x64");
    }

    private static String getNodeDownloadUrl() {
        String ext = IS_WINDOWS ? ".zip" : ".tar.gz";
        return "https://nodejs.org/dist/v" + NODE_VERSION + "/" + getNodeDirName() + ext;
    }

    private static boolean downloadAndExtractNode(File runtimeDir, File targetDir) {
        if (!runtimeDir.exists() && !runtimeDir.mkdirs()) {
            System.err.println("  Failed to create runtime directory: " + runtimeDir.getAbsolutePath());
            return false;
        }

        String archiveName = IS_WINDOWS ? "node.zip" : "node.tar.gz";
        File archiveFile = new File(runtimeDir, archiveName);
        String downloadUrl = getNodeDownloadUrl();

        try {
            System.out.println("  Downloading: " + downloadUrl);
            downloadFile(downloadUrl, archiveFile);

            System.out.println("  Extracting into " + runtimeDir.getAbsolutePath() + "...");
            if (IS_WINDOWS) {
                extractZip(archiveFile, runtimeDir);
            } else {
                extractTarGz(archiveFile, runtimeDir);
            }
        } catch (Exception e) {
            System.err.println("  Failed to download/extract Node.js: " + e.getMessage());
            return false;
        } finally {
            if (archiveFile.exists()) {
                archiveFile.delete();
            }
        }

        File localNode = new File(targetDir, IS_WINDOWS ? "node.exe" : "bin" + File.separator + "node");
        if (!IS_WINDOWS && localNode.exists()) {
            localNode.setExecutable(true);
        }

        if (isUsableNode(localNode)) {
            nodePath = localNode.getAbsolutePath();
            System.out.println("  Portable Node.js ready: " + nodePath);
            return true;
        }
        System.err.println("  Node.js executable missing or unusable after extraction.");
        return false;
    }

    private static void downloadFile(String urlStr, File destination) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) URI.create(urlStr).toURL().openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "GameStarter/1.0");
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(60_000);

        int status = conn.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IOException("HTTP " + status + " downloading " + urlStr);
        }

        long totalBytes = conn.getContentLengthLong();
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(destination)) {
            byte[] buffer = new byte[8192];
            long downloaded = 0;
            int nextPct = 20;
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                downloaded += read;
                if (totalBytes > 0) {
                    int pct = (int) ((downloaded * 100) / totalBytes);
                    if (pct >= nextPct) {
                        System.out.println("    " + pct + "% downloaded...");
                        nextPct += 20;
                    }
                }
            }
        }
    }

    private static void extractZip(File zipFile, File destDir) throws IOException {
        Path destRoot = destDir.toPath().toAbsolutePath().normalize();
        try (ZipInputStream zis = new ZipInputStream(new FileInputStream(zipFile))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path target = destRoot.resolve(entry.getName()).normalize();
                if (!target.startsWith(destRoot)) {
                    throw new IOException("Blocked unsafe zip entry: " + entry.getName());
                }
                File outFile = target.toFile();
                if (entry.isDirectory()) {
                    outFile.mkdirs();
                } else {
                    File parent = outFile.getParentFile();
                    if (parent != null) {
                        parent.mkdirs();
                    }
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        byte[] buffer = new byte[8192];
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                }
                zis.closeEntry();
            }
        }
    }

    private static void extractTarGz(File tarGzFile, File destDir) throws IOException {
        try {
            Process proc = new ProcessBuilder(
                    "tar", "-xzf", tarGzFile.getAbsolutePath(), "-C", destDir.getAbsolutePath())
                    .redirectErrorStream(true)
                    .start();
            readLines(proc.getInputStream());
            if (proc.waitFor() == 0) {
                return;
            }
        } catch (Exception ignored) {
            // Fall back to Java tar extraction
        }

        try (FileInputStream fis = new FileInputStream(tarGzFile);
             GZIPInputStream gzis = new GZIPInputStream(fis)) {
            extractTar(gzis, destDir);
        }
    }

    private static void extractTar(InputStream tarStream, File destDir) throws IOException {
        Path destRoot = destDir.toPath().toAbsolutePath().normalize();
        byte[] header = new byte[512];
        while (readFully(tarStream, header) == 512) {
            if (isAllZero(header)) {
                break;
            }
            String name = extractAscii(header, 0, 100);
            if (name.isEmpty()) {
                break;
            }
            char type = (char) header[156];
            long size = parseOctal(header, 124, 12);

            Path target = destRoot.resolve(name).normalize();
            if (!target.startsWith(destRoot)) {
                throw new IOException("Blocked unsafe tar entry: " + name);
            }
            File outFile = target.toFile();

            if (type == '5' || name.endsWith("/")) {
                outFile.mkdirs();
            } else if (type == '0' || type == 0) {
                File parent = outFile.getParentFile();
                if (parent != null) {
                    parent.mkdirs();
                }
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    long remaining = size;
                    byte[] buffer = new byte[8192];
                    while (remaining > 0) {
                        int bytesRead = tarStream.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                        if (bytesRead < 0) {
                            break;
                        }
                        fos.write(buffer, 0, bytesRead);
                        remaining -= bytesRead;
                    }
                }
                skipFully(tarStream, (512 - (size % 512)) % 512);
            } else if (type == '2' && !IS_WINDOWS) {
                String linkTarget = extractAscii(header, 157, 100);
                try {
                    Files.createSymbolicLink(target, Paths.get(linkTarget));
                } catch (Exception ignored) {
                    // Best-effort symlink recreation
                }
            } else {
                long blocks = (size + 511) / 512;
                skipFully(tarStream, blocks * 512);
            }
        }
    }

    private static int readFully(InputStream in, byte[] buffer) throws IOException {
        int offset = 0;
        while (offset < buffer.length) {
            int read = in.read(buffer, offset, buffer.length - offset);
            if (read < 0) {
                break;
            }
            offset += read;
        }
        return offset;
    }

    private static void skipFully(InputStream in, long bytes) throws IOException {
        long remaining = bytes;
        while (remaining > 0) {
            long skipped = in.skip(remaining);
            if (skipped <= 0) {
                if (in.read() < 0) {
                    break;
                }
                remaining--;
            } else {
                remaining -= skipped;
            }
        }
    }

    private static boolean isAllZero(byte[] block) {
        for (byte b : block) {
            if (b != 0) {
                return false;
            }
        }
        return true;
    }

    private static String extractAscii(byte[] buffer, int offset, int length) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < length; i++) {
            byte b = buffer[offset + i];
            if (b == 0) {
                break;
            }
            sb.append((char) b);
        }
        return sb.toString().trim();
    }

    private static long parseOctal(byte[] buffer, int offset, int length) {
        long result = 0;
        for (int i = 0; i < length; i++) {
            byte b = buffer[offset + i];
            if (b == 0 || b == ' ') {
                break;
            }
            if (b >= '0' && b <= '7') {
                result = result * 8 + (b - '0');
            }
        }
        return result;
    }

    // ==================== Server Lifecycle ====================

    private static void killExistingServerOnPort() {
        System.out.println("[2/3] Checking for existing process on port " + PORT + "...");
        List<String> pids = IS_WINDOWS ? findWindowsPidsOnPort() : findUnixPidsOnPort();
        if (pids.isEmpty()) {
            System.out.println("  Port " + PORT + " is free.");
            return;
        }

        for (String pid : pids) {
            try {
                System.out.println("  Stopping existing process PID " + pid + "...");
                if (IS_WINDOWS) {
                    new ProcessBuilder("taskkill", "/F", "/PID", pid).start().waitFor(5, TimeUnit.SECONDS);
                } else {
                    new ProcessBuilder("kill", "-9", pid).start().waitFor(5, TimeUnit.SECONDS);
                }
            } catch (Exception e) {
                System.err.println("  Warning: could not stop PID " + pid + ": " + e.getMessage());
            }
        }

        try {
            Thread.sleep(750);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static List<String> findUnixPidsOnPort() {
        List<String> pids = new ArrayList<>();
        String[] lsofCommands = new String[] { "/usr/sbin/lsof", "lsof" };
        for (String lsofBin : lsofCommands) {
            try {
                Process proc = new ProcessBuilder(lsofBin, "-t", "-i:" + PORT).start();
                for (String line : readLines(proc.getInputStream())) {
                    String trimmed = line.trim();
                    if (!trimmed.isEmpty() && !pids.contains(trimmed)) {
                        pids.add(trimmed);
                    }
                }
                proc.waitFor(5, TimeUnit.SECONDS);
                return pids;
            } catch (IOException ignored) {
                // Try fallback lsof location
            } catch (Exception e) {
                System.err.println("  Warning checking port " + PORT + ": " + e.getMessage());
                return pids;
            }
        }
        return pids;
    }

    private static List<String> findWindowsPidsOnPort() {
        List<String> pids = new ArrayList<>();
        try {
            Process proc = new ProcessBuilder("cmd.exe", "/c", "netstat -ano").start();
            for (String line : readLines(proc.getInputStream())) {
                String trimmed = line.trim();
                if (trimmed.contains(":" + PORT) && trimmed.contains("LISTENING")) {
                    String[] parts = trimmed.split("\\s+");
                    if (parts.length >= 5) {
                        String pid = parts[parts.length - 1];
                        if (!"0".equals(pid) && !pids.contains(pid)) {
                            pids.add(pid);
                        }
                    }
                }
            }
            proc.waitFor(5, TimeUnit.SECONDS);
        } catch (Exception e) {
            System.err.println("  Warning checking Windows port " + PORT + ": " + e.getMessage());
        }
        return pids;
    }

    private static void startServer(File gameDir) throws IOException {
        System.out.println("[3/3] Starting Node.js game server...");
        synchronized (SERVER_LOCK) {
            ProcessBuilder pb = new ProcessBuilder(nodePath, SERVER_FILE_NAME);
            pb.directory(gameDir);
            pb.redirectErrorStream(true);

            File nodeFile = new File(nodePath);
            if (nodeFile.isAbsolute() && nodeFile.getParent() != null) {
                String currentPath = pb.environment().getOrDefault("PATH", "");
                pb.environment().put("PATH", nodeFile.getParent() + File.pathSeparator + currentPath);
            }

            Process started = pb.start();
            serverProcess = started;

            Thread logThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(started.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        System.out.println("[SERVER] " + line);
                    }
                } catch (IOException ignored) {
                    // Process output stream closed
                }
            }, "server-log-reader");
            logThread.setDaemon(true);
            logThread.start();
        }
    }

    private static boolean waitForServerReady() {
        for (int attempt = 0; attempt < 30; attempt++) {
            Process proc = serverProcess;
            if (proc == null || !proc.isAlive()) {
                return false;
            }
            if (isHttpReady()) {
                return true;
            }
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    private static boolean isHttpReady() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) URI.create(HEALTH_URL).toURL().openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(1000);
            conn.setReadTimeout(1000);
            return conn.getResponseCode() == HttpURLConnection.HTTP_OK;
        } catch (IOException e) {
            return false;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void stopManagedServer() {
        Process proc;
        synchronized (SERVER_LOCK) {
            proc = serverProcess;
            serverProcess = null;
        }
        if (proc == null) {
            return;
        }
        if (proc.isAlive()) {
            proc.destroy();
            try {
                if (!proc.waitFor(2, TimeUnit.SECONDS)) {
                    proc.destroyForcibly();
                    proc.waitFor(2, TimeUnit.SECONDS);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                proc.destroyForcibly();
            }
        }
    }

    // ==================== Browser Launch & Console ====================

    private static void openGameInChrome() {
        System.out.println("  Opening " + GAME_URL + " in Google Chrome...");
        if (IS_MAC) {
            if (runBrowserCommand("open", "-a", "Google Chrome", GAME_URL)) {
                return;
            }
            if (runBrowserCommand("open", GAME_URL)) {
                return;
            }
        } else if (IS_WINDOWS) {
            if (runBrowserCommand("cmd.exe", "/c", "start", "", "chrome", GAME_URL)) {
                return;
            }
        } else {
            if (runBrowserCommand("google-chrome", GAME_URL)
                    || runBrowserCommand("chromium", GAME_URL)
                    || runBrowserCommand("xdg-open", GAME_URL)) {
                return;
            }
        }

        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(GAME_URL));
                return;
            }
        } catch (Exception e) {
            System.err.println("  Warning: could not open browser automatically: " + e.getMessage());
        }
        System.out.println("  Please open " + GAME_URL + " in Google Chrome manually.");
    }

    private static boolean runBrowserCommand(String... command) {
        try {
            Process proc = new ProcessBuilder(command).redirectErrorStream(true).start();
            readLines(proc.getInputStream());
            return proc.waitFor(5, TimeUnit.SECONDS) && proc.exitValue() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    private static void runInteractiveLoop(File gameDir) throws IOException {
        System.out.println();
        System.out.println("Game server is running!");
        System.out.println("  - Press Enter to restart the server");
        System.out.println("  - Type 'open' to reopen Google Chrome");
        System.out.println("  - Type 'q' (or press Stop in Eclipse) to stop and exit");

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        while (true) {
            String line = reader.readLine();
            if (line == null) {
                System.out.println("\nInput stream closed. Stopping server...");
                stopManagedServer();
                break;
            }
            String cmd = line.trim().toLowerCase(Locale.ROOT);
            if ("q".equals(cmd) || "quit".equals(cmd) || "exit".equals(cmd)) {
                System.out.println("Stopping server and exiting...");
                stopManagedServer();
                break;
            } else if ("open".equals(cmd)) {
                openGameInChrome();
            } else if (cmd.isEmpty() || "r".equals(cmd) || "restart".equals(cmd)) {
                System.out.println("\nRestarting server...");
                stopManagedServer();
                killExistingServerOnPort();
                startServer(gameDir);
                if (waitForServerReady()) {
                    System.out.println("  Server restarted at " + GAME_URL);
                } else {
                    System.err.println("  Server failed to restart cleanly.");
                }
            } else {
                System.out.println("Unknown command. Press Enter to restart, 'open' for Chrome, or 'q' to quit.");
            }
        }
    }

    private static List<String> readLines(InputStream in) throws IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in))) {
            String line;
            while ((line = reader.readLine()) != null) {
                lines.add(line);
            }
        }
        return lines;
    }
}
