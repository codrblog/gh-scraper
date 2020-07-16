const glob = require('glob');
const ChildProcess = require('child_process');
const Crypto = require('crypto');
const deleteFolder = require('del');
const FS = require('fs');
const Path = require('path');
const Http = require('http');
const Https = require('https');
const LOG = (...args) => console.log(`[${new Date().toISOString()}] `, ...args);
const tmpFolder = Path.join(__dirname, 'tmp');
const MACOS_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.116 Safari/537.36';
const CACHE_TIME = process.env.CACHE_TIME || 3600_000;
const HEADERS = {
  'Host': 'github.com',
  'User-Agent': MACOS_CHROME,
};

let jobQueue = [];

const JobState = {
  New: 1,
  ReadyToRemove: 2,
};

glob(tmpFolder + '/*', function (_, files) {
  files.forEach(file => {
    const id = Path.basename(file);
    const folder = Path.join(tmpFolder, id);

    jobQueue.push({
      id,
      folder,
      time: Date.now(),
      state: JobState.ReadyToRemove,
    });
  });
})

function sha256(input) {
  return Crypto.createHash('sha256').update(input).digest('hex');
}

function request(url, options) {
  return new Promise((resolve, reject) => {
    const { host, protocol, path } = new URL(url);
    const request = Https.request({ host, protocol, path, headers: HEADERS, timeout: 60_000, ...options, });

    request.on('error', (error) => {
      LOG('ERR', url, error.message);
      reject(error);
    });
    request.on('timeout', () => {
      LOG('OUT', url);
      reject(new Error('TIMEOUT'));
    });
    request.on('response', (response) => {
      LOG('OK', url, response.statusCode);
      resolve(response);
    });
    request.end();
  });
}

function checkIfRepoExists(repo) {
  const url = `https://github.com/${repo}.git`;
  return request(url, { method: 'HEAD' }).then(response => Boolean(response.statusCode === 200), () => false);
}

function downloadRepo(repo) {
  const id = sha256(repo);
  const folder = Path.join(tmpFolder, id);
  const url = `https://github.com/${repo}.git`;
  const shOptions = { stdio: 'pipe', shell: true };

  if (FS.existsSync(folder)) {
    LOG(`Used cache for ${repo}`);
    return Promise.resolve(id);
  }

  jobQueue.push({
    id,
    time: Date.now(),
    state: JobState.New,
    folder
  });

  LOG('clone', url, folder);
  const clone = ChildProcess.spawn('git', ['clone', '--depth', '1', `'${url}'`, folder], shOptions);

  return new Promise((resolve, reject) => {
    clone.on('error', reject);
    clone.on('close', () => resolve(id));
    clone.on('exit', (code) => code === 0 ? resolve(id) : reject());
  });
}

function readArticles(id) {
  return new Promise(resolve => {
    const folder = Path.join(tmpFolder, id);
    const articles = [];
    let readme = null;

    glob(`${folder}/**/*.md`, async (_, files) => {
      const EMPTY_META = { title: '', description: '' };

      for (filePath of files) {
        const relativePath = filePath.replace(folder + '/', '');
        const slug = relativePath.slice(0, -3); // .md
        const contentBuffer = await FS.promises.readFile(filePath);
        const stats = await FS.promises.stat(filePath);
        const rawContent = contentBuffer.toString('utf8').trim();
        const lastModified = Number(stats.mtimeMs);
        const createdAt = Number(stats.birthtimeMs);
        const hasMetadata = rawContent.startsWith('{');
        const metaEnd = rawContent.indexOf('}\n');
        const meta = hasMetadata ? parseMetadata(rawContent.slice(1, metaEnd)) : EMPTY_META;
        const content = hasMetadata ? rawContent.slice(metaEnd + 1) : rawContent;
        const title = meta.title || content.split('\n')[0].replace(/^[#]{1,}\s/, '') || slug;

        const article = {
          slug,
          title,
          meta,
          content,
          lastModified,
          createdAt,
        };

        if (slug.toLowerCase() === 'readme') {
          readme = article;
        } else {
          articles.push(article);
        }
      }

      articles.sort((a, b) => b.lastModified - a.lastModified);
      resolve({ articles, readme });
    });
  });
}

async function readMetadata(id, readme) {
  const folder = Path.join(tmpFolder, id);
  const metadataFile = Path.join(folder, 'blog.json');
  const exists = FS.existsSync(metadataFile);

  const metadata = exists ? toJSON(await FS.promises.readFile(metadataFile)) : {};
  metadata.about = readme;

  return metadata;
}

function markForRemoval(id) {
  jobQueue.forEach(job => job.id === id && (job.state = JobState.ReadyToRemove))
}

function toJSON(text) {
  try {
    return JSON.parse(text);
  } catch { return {}; }
}

async function removeFolders() {
  const timeLimit = Date.now() - CACHE_TIME;
  const job = jobQueue.find(job => job.state === JobState.ReadyToRemove && job.time < timeLimit);

  if (job) {
    LOG(`Removing ${job.id}`);
    deleteFolder(`${job.folder}`);
    jobQueue = jobQueue.filter(item => item !== job);
  }
}

const server = Http.createServer(async function (request, response) {
  if (request.url === '/favicon.ico') {
    response.writeHead(404);
    response.end('');
    return;
  }

  const repo = request.url.slice(1);
  if (!repo) {
    response.writeHead(400);
    response.end('');
    return;
  }

  try {
    await checkIfRepoExists(repo);
  } catch {
    response.writeHead(404, 'Not found');
    response.end('');
    return;
  }

  try {
    const id = await downloadRepo(repo);
    const { articles, readme } = await readArticles(id);
    const metadata = await readMetadata(id, readme);
    const payload = { repo, metadata, articles };

    markForRemoval(id);
    response.end(JSON.stringify(payload, null, 2));

  } catch (error) {
    LOG(error);
    response.writeHead(400);
    response.end();
  }
});

setInterval(removeFolders, 5000);

server.listen(process.env.PORT || 3000);