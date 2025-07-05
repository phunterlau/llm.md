browser.runtime.onMessage.addListener(handleMessages);

function handleMessages(message) {
  if (message.target !== 'offscreen') {
    return;
  }
  switch (message.type) {
    case 'parse-dom':
      const parser = new DOMParser();
      const dom = parser.parseFromString(message.domString, "text/html");
      const article = new Readability(dom).parse();
      browser.runtime.sendMessage({
        type: 'parse-dom-result',
        article: article
      });
      break;
    case 'turndown':
      try {
        const result = turndownWithOptimizations(message.content, message.options, message.article);
        browser.runtime.sendMessage({
          type: 'turndown-result',
          markdown: result.markdown,
          imageList: result.imageList
        });
      } catch (error) {
        console.error('Error in turndown processing:', error);
        browser.runtime.sendMessage({
          type: 'turndown-result',
          markdown: 'Error processing content: ' + error.message,
          imageList: {}
        });
      }
      break;
    case 'create-download-url':
      try {
        const url = handleDownload(message.markdown, message.filename);
        browser.runtime.sendMessage({
          type: 'create-download-url-result',
          url: url
        });
      } catch (error) {
        console.error('Error creating download URL:', error);
        browser.runtime.sendMessage({
          type: 'create-download-url-result',
          error: error.message
        });
      }
      break;
    case 'predownload-images':
      try {
        handleImagePreDownload(message.imageList, message.markdown, message.options).then(result => {
          browser.runtime.sendMessage({
            type: 'predownload-images-result',
            imageList: result.imageList,
            markdown: result.markdown
          });
        }).catch(error => {
          console.error('Error pre-downloading images:', error);
          browser.runtime.sendMessage({
            type: 'predownload-images-result',
            error: error.message
          });
        });
      } catch (error) {
        console.error('Error pre-downloading images:', error);
        browser.runtime.sendMessage({
          type: 'predownload-images-result',
          error: error.message
        });
      }
      break;
    default:
      console.warn(`Unexpected message type received: '${message.type}'.`);
  }
}

function cleanAttribute(attribute) {
  return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}

function validateUri(href, baseURI) {
  try {
    new URL(href);
  }
  catch {
    const baseUri = new URL(baseURI);
    if (href.startsWith('/')) {
      href = baseUri.origin + href;
    }
    else {
      href = baseUri.href + (baseUri.href.endsWith('/') ? '' : '/') + href;
    }
  }
  // Remove tracking parameters for LLM optimization
  const url = new URL(href);
  const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
  for (const param of trackingParams) {
    url.searchParams.delete(param);
  }
  return url.toString();
}

function generateValidFileName(title, disallowedChars = null) {
  if (!title) return title;
  else title = title + '';
  var illegalRe = /[\/\?<>\\:\*\|":]/g;
  var name = title.replace(illegalRe, "").replace(new RegExp('\u00A0', 'g'), ' ')
      .replace(new RegExp(/\s+/, 'g'), ' ')
      .trim();
  if (disallowedChars) {
    for (let c of disallowedChars) {
      if (`[\\^$.|?*+()`.includes(c)) c = `\\${c}`;
      name = name.replace(new RegExp(c, 'g'), '');
    }
  }
  return name;
}

function getImageFilename(src, options, prependFilePath = true) {
  const slashPos = src.lastIndexOf('/');
  const queryPos = src.indexOf('?');
  let filename = src.substring(slashPos + 1, queryPos > 0 ? queryPos : src.length);
  let imagePrefix = (options.imagePrefix || '');
  if (prependFilePath && options.title && options.title.includes('/')) {
    imagePrefix = options.title.substring(0, options.title.lastIndexOf('/') + 1) + imagePrefix;
  }
  else if (prependFilePath && options.title) {
    imagePrefix = options.title + (imagePrefix.startsWith('/') ? '' : '/') + imagePrefix;
  }
  if (filename.includes(';base64,')) {
    filename = 'image.' + filename.substring(0, filename.indexOf(';'));
  }
  let extension = filename.substring(filename.lastIndexOf('.'));
  if (extension == filename) {
    filename = filename + '.idunno';
  }
  filename = generateValidFileName(filename, options.disallowedChars);
  return imagePrefix + filename;
}

function turndownWithOptimizations(content, options, article) {
  var turndownService = new TurndownService(options);
  
  // Handle escape function properly
  if (!options.turndownEscape) {
    turndownService.escape = s => s;
  }
  turndownService.use(turndownPluginGfm.gfm);
  turndownService.keep(['iframe', 'sub', 'sup', 'u', 'ins', 'del', 'small', 'big']);

  let imageList = {};
  
  // Add an image rule
  turndownService.addRule('images', {
    filter: function (node, tdopts) {
      if (node.nodeName == 'IMG' && node.getAttribute('src')) {
        let src = node.getAttribute('src');
        // Apply LLM optimization for links if enabled
        if (options.llmOptimized) {
          src = validateUri(src, article.baseURI);
          node.setAttribute('src', src);
        }
        if (options.downloadImages) {
          let imageFilename = getImageFilename(src, options, false);
          if (!imageList[src] || imageList[src] != imageFilename) {
            let i = 1;
            while (Object.values(imageList).includes(imageFilename)) {
              const parts = imageFilename.split('.');
              if (i == 1) parts.splice(parts.length - 1, 0, i++);
              else parts.splice(parts.length - 2, 1, i++);
              imageFilename = parts.join('.');
            }
            imageList[src] = imageFilename;
          }
          const obsidianLink = options.imageStyle && options.imageStyle.startsWith("obsidian");
          const localSrc = options.imageStyle === 'obsidian-nofolder'
            ? imageFilename.substring(imageFilename.lastIndexOf('/') + 1)
            : imageFilename.split('/').map(s => obsidianLink ? s : encodeURI(s)).join('/');
          
          if(options.imageStyle != 'originalSource' && options.imageStyle != 'base64') node.setAttribute('src', localSrc);
          return true;
        }
        else return true;
      }
      return false;
    },
    replacement: function (content, node, tdopts) {
      if (options.imageStyle == 'noImage') return '';
      else if (options.imageStyle && options.imageStyle.startsWith('obsidian')) return `![[${node.getAttribute('src')}]]`;
      else {
        var alt = cleanAttribute(node.getAttribute('alt'));
        var src = node.getAttribute('src') || '';
        var title = cleanAttribute(node.getAttribute('title'));
        var titlePart = title ? ' "' + title + '"' : '';
        if (options.imageRefStyle == 'referenced') {
          var id = this.references.length + 1;
          this.references.push('[fig' + id + ']: ' + src + titlePart);
          return '![' + alt + '][fig' + id + ']';
        }
        else return src ? '![' + alt + ']' + '(' + src + titlePart + ')' : '';
      }
    },
    references: [],
    append: function (options) {
      var references = '';
      if (this.references.length) {
        references = '\n\n' + this.references.join('\n') + '\n\n';
        this.references = []; // Reset references
      }
      return references;
    }
  });

  // Add a rule for links
  turndownService.addRule('links', {
    filter: (node, tdopts) => {
      if (node.nodeName == 'A' && node.getAttribute('href')) {
        const href = node.getAttribute('href');
        // Apply LLM optimization for links if enabled
        if (options.llmOptimized) {
          node.setAttribute('href', validateUri(href, article.baseURI));
        }
        return options.linkStyle == 'stripLinks';
      }
      return false;
    },
    replacement: (content, node, tdopts) => content
  });

  // Handle multiple lines math
  turndownService.addRule('math', {
    filter: 'math',
    replacement: function (content, node, options) {
      // First, try to get the annotation content
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        let tex = annotation.textContent.trim().replaceAll('\xa0', '');
        if (node.getAttribute('display') === 'inline') {
          tex = tex.replaceAll('\n', ' ');
          return `$${tex}$`;
        }
        else return `$$\n${tex}\n$$`;
      }

      // Fallback for other math content
      if (article.math && article.math.hasOwnProperty(node.id)) {
        const math = article.math[node.id];
        let tex = math.tex.trim().replaceAll('\xa0', '');
        if (math.inline) {
          tex = tex.replaceAll('\n', ' ');
          return `$${tex}$`;
        }
        else return `$$\n${tex}\n$$`;
      }

      // Final fallback: return the content as is, wrapped in math delimiters
      const isInline = node.getAttribute('display') !== 'block';
      if (isInline) {
        return `$${content}$`;
      }
      else {
        return `$$\n${content}\n$$`;
      }
    }
  });

  function repeat(character, count) {
    return Array(count + 1).join(character);
  }

  function convertToFencedCodeBlock(node, options) {
    node.innerHTML = node.innerHTML.replaceAll('<br-keep></br-keep>', '<br>');
    const langMatch = node.id?.match(/code-lang-(.+)/);
    const language = langMatch?.length > 0 ? langMatch[1] : '';
    const code = node.innerText;
    const fenceChar = options.fence.charAt(0);
    let fenceSize = 3;
    const fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');
    let match;
    while ((match = fenceInCodeRegex.exec(code))) {
      if (match[0].length >= fenceSize) {
        fenceSize = match[0].length + 1;
      }
    }
    const fence = repeat(fenceChar, fenceSize);
    return (
      '\n\n' + fence + language + '\n' +
      code.replace(/\n$/, '') +
      '\n' + fence + '\n\n'
    );
  }

  turndownService.addRule('fencedCodeBlock', {
    filter: function (node, options) {
      return (
        options.codeBlockStyle === 'fenced' &&
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE'
      );
    },
    replacement: function (content, node, options) {
      return convertToFencedCodeBlock(node.firstChild, options);
    }
  });

  turndownService.addRule('pre', {
    filter: (node, tdopts) => {
      return node.nodeName == 'PRE'
             && (!node.firstChild || node.firstChild.nodeName != 'CODE')
             && !node.querySelector('img');
    },
    replacement: (content, node, tdopts) => {
      return convertToFencedCodeBlock(node, tdopts);
    }
  });

  // Handle multiple tbodies in a table
  turndownService.addRule('multiple-tbodies', {
    filter: 'table',
    replacement: function (content, node) {
      let markdown = '';
      const tbodies = node.querySelectorAll('tbody');
      if (tbodies.length > 1) {
        tbodies.forEach(tbody => {
          markdown += turndownService.turndown(tbody);
        });
        return markdown;
      }
      return content;
    }
  });

  // Handle td elements in a more graceful way
  turndownService.addRule('td', {
    filter: 'td',
    replacement: function (content, node) {
      return content.trim() + ' ';
    }
  });

  let markdown = turndownService.turndown(content);

  if (options.includeToc) {
    const toc = generateToc(markdown);
    markdown = toc + markdown;
  }

  markdown = (options.frontmatter || '') + markdown + (options.backmatter || '');
  markdown = markdown.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff\ufff9-\ufffc]/g, '');
  
  // Collapse multiple consecutive blank lines into a single blank line
  markdown = markdown.replace(/\n{3,}/g, '\n\n');

  return { markdown: markdown, imageList: imageList };
}

function generateToc(markdown) {
  const toc = [];
  const lines = markdown.split('\n');
  const headingRegex = /^(#+)\s+(.*)/;

  lines.forEach(line => {
    const match = line.match(headingRegex);
    if (match) {
      const level = match[1].length;
      const title = match[2];
      const slug = title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      toc.push(`${'  '.repeat(level - 1)}- [${title}](#${slug})`);
    }
  });

  if (toc.length > 0) {
    return `## Table of Contents\n\n${toc.join('\n')}\n\n---\n\n`;
  }
  return '';
}

// Add replaceAll polyfill if not available
if (!String.prototype.replaceAll) {
  String.prototype.replaceAll = function(str, newStr){
    if (Object.prototype.toString.call(str).toLowerCase() === '[object regexp]') {
      return this.replace(str, newStr);
    }
    return this.replace(new RegExp(str, 'g'), newStr);
  };
}

// Handle download operations
function handleDownload(markdown, filename) {
  const url = URL.createObjectURL(new Blob([markdown], {
    type: "text/markdown;charset=utf-8"
  }));
  return url;
}

// Handle image pre-download
async function handleImagePreDownload(imageList, markdown, options) {
  let newImageList = {};
  await Promise.all(Object.entries(imageList).map(([src, filename]) => new Promise((resolve, reject) => {
    fetch(src)
      .then(response => response.blob())
      .then(async blob => {
        if (options.imageStyle == 'base64') {
          var reader = new FileReader();
          reader.onloadend = function () {
            markdown = markdown.replaceAll(src, reader.result);
            resolve();
          }
          reader.readAsDataURL(blob);
        } else {
          let newFilename = filename;
          if (newFilename.endsWith('.idunno')) {
            // Note: mimedb is not available here, so we'll use a simple mapping
            const mimeToExt = {
              'image/jpeg': 'jpg',
              'image/png': 'png',
              'image/gif': 'gif',
              'image/webp': 'webp',
              'image/svg+xml': 'svg'
            };
            const ext = mimeToExt[blob.type] || 'jpg';
            newFilename = filename.replace('.idunno', '.' + ext);
            if (!options.imageStyle.startsWith("obsidian")) {
              markdown = markdown.replaceAll(filename.split('/').map(s => encodeURI(s)).join('/'), newFilename.split('/').map(s => encodeURI(s)).join('/'));
            } else {
              markdown = markdown.replaceAll(filename, newFilename);
            }
          }
          const blobUrl = URL.createObjectURL(blob);
          newImageList[blobUrl] = newFilename;
          resolve();
        }
      })
      .catch(() => reject('A network error occurred attempting to download ' + src));
  })));
  return { imageList: newImageList, markdown: markdown };
}
