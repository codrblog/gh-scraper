const request = require('request');
const glob = require('glob');
const FS = require('fs');
const Path = require('path');

function repoExists(repo) {
  return new Promise((resolve) => {
    request.head(`https://github.com/${repo}.git`, function (error, response) {
      resolve(Boolean(!error && response.statusCode === 200));
    });
  });
}

function download(repo) {
  return new Promise((resolve, reject) => {
    const filePath = Path.join(__dirname, 'tmp', Date.now() + '.zip');
    const file = FS.createWriteStream(filePath);

    request.get(`https://github.com/${repo}/archive/master.zip`, (e, response) => (e || response.statusCode !== 200) && reject(e) || resolve(filePath)).pipe(file);
    file.on('close', () => { console.log('close'); resolve(filePath); });
    file.on('unpipe', () => { console.log('unpipe'); resolve(filePath); });
  });
}

function readFiles(folderPath) {
  glob(`${folderPath}/**/*.md`, async (_, files) => {
    for (filePath of files) {
      const slug = filePath.slice(0, -3);
      const fullPath = Path.join(__dirname, filePath);
      const contentBuffer = await FS.promises.readFile(fullPath);
      const stats = await FS.promises.stat(fullPath);
      const rawContent = contentBuffer.toString('utf8').trim();
      const lastModified = Number(stats.mtimeMs);
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
      };

      if (!index.has(slug)) {
        allArticles.push(article);
        index.set(slug, article);
      } else if (index.get(slug).lastModified < lastModified) {
        const articleIndex = allArticles.findIndex(a => a.slug === slug);
        allArticles[articleIndex] = article;
        index.set(slug, article);
      }

      getMarkdownFor(article);
    }

    allArticles.sort((a, b) => b.lastModified - a.lastModified);
    saveCache();
  });
}

const server = require('http').createServer(async function (request, response) {
  const repo = request.url.slice(1);

  if (!repo) {
    response.writeHead(400);
    response.end('')
    return;
  }

  const exists = await repoExists(repo);

  if (!exists) {
    response.writeHead(404, 'Not found');
    response.end('');
    return;
  }

  const filePath = await download(repo);
  response.end(filePath);
});

server.listen(process.env.PORT || 3000);