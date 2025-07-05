// Import all the necessary scripts
importScripts(
  'browser-polyfill.min.js',
  'background/apache-mime-types.js',
  'background/moment.min.js',
  'shared/context-menus.js',
  'shared/default-options.js'
);

// Log some info
browser.runtime.getPlatformInfo().then(async platformInfo => {
  const browserInfo = browser.runtime.getBrowserInfo ? await browser.runtime.getBrowserInfo() : "Can't get browser info";
  console.info(platformInfo, browserInfo);
});

// Add notification listener for foreground page messages
browser.runtime.onMessage.addListener(notify);
// Create context menus
createMenus();

async function turndown(content, options, article) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.runtime.onMessage.removeListener(listener);
      reject(new Error('Turndown operation timed out'));
    }, 30000); // 30 second timeout

    const listener = (message) => {
      if (message.type === 'turndown-result') {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        resolve({ markdown: message.markdown, imageList: message.imageList || {} });
      }
    };
    
    browser.runtime.onMessage.addListener(listener);
    
    try {
      browser.runtime.sendMessage({
        target: 'offscreen',
        type: 'turndown',
        content: content,
        options: options,
        article: article
      }).catch((error) => {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        reject(error);
      });
    } catch (error) {
      clearTimeout(timeout);
      browser.runtime.onMessage.removeListener(listener);
      reject(error);
    }
  });
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
  // Remove tracking parameters
  const url = new URL(href);
  const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
  for (const param of trackingParams) {
    url.searchParams.delete(param);
  }
  return url.toString();
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

function textReplace(string, article, disallowedChars = null) {
  for (const key in article) {
    if (article.hasOwnProperty(key) && key != "content") {
      let s = (article[key] || '') + '';
      if (s && disallowedChars) s = generateValidFileName(s, disallowedChars);
      string = string.replace(new RegExp('{' + key + '}', 'g'), s)
        .replace(new RegExp('{' + key + ':lower}', 'g'), s.toLowerCase())
        .replace(new RegExp('{' + key + ':upper}', 'g'), s.toUpperCase())
        .replace(new RegExp('{' + key + ':kebab}', 'g'), s.replace(/ /g, '-').toLowerCase())
        .replace(new RegExp('{' + key + ':mixed-kebab}', 'g'), s.replace(/ /g, '-'))
        .replace(new RegExp('{' + key + ':snake}', 'g'), s.replace(/ /g, '_').toLowerCase())
        .replace(new RegExp('{' + key + ':mixed_snake}', 'g'), s.replace(/ /g, '_'))
        .replace(new RegExp('{' + key + ':obsidian-cal}', 'g'), s.replace(/ /g, '-').replace(/-{2,}/g, "-"))
        .replace(new RegExp('{' + key + ':camel}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()).replace(/^./, (str) => str.toLowerCase()))
        .replace(new RegExp('{' + key + ':pascal}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()).replace(/^./, (str) => str.toUpperCase()));
    }
  }
  const now = new Date();
  const dateRegex = /{date:(.+?)}/g;
  const matches = string.match(dateRegex);
  if (matches && matches.forEach) {
    matches.forEach(match => {
      const format = match.substring(6, match.length - 1);
      const dateString = moment(now).format(format);
      string = string.replaceAll(match, dateString);
    });
  }
  const keywordRegex = /{keywords:?(.*)?}/g;
  const keywordMatches = string.match(keywordRegex);
  if (keywordMatches && keywordMatches.forEach) {
    keywordMatches.forEach(match => {
      let seperator = match.substring(10, match.length - 1);
      try {
        seperator = JSON.parse(JSON.stringify(seperator).replace(/\\\\/g, '\\'));
      }
      catch { }
      const keywordsString = (article.keywords || []).join(seperator);
      string = string.replace(new RegExp(match.replace(/\\/g, '\\\\'), 'g'), keywordsString);
    });
  }
  const defaultRegex = /{(.*?)}/g;
  string = string.replace(defaultRegex, '');
  return string;
}

async function convertArticleToMarkdown(article, downloadImages = null) {
  const options = await getOptions();
  if (downloadImages != null) {
    options.downloadImages = downloadImages;
  }
  
  // Apply LLM optimizations if enabled
  if (options.llmOptimized) {
    // Add structured frontmatter for LLM processing
    // Use multi-layered URL retrieval for maximum reliability
    const articleUrl = article.tabUrl || article.url || article.baseURI || '';
    
    const llmFrontmatter = `---
title: "${article.title || 'Untitled'}"
url: "${articleUrl}"
date: "${new Date().toISOString()}"
author: "${article.byline || 'Unknown'}"
excerpt: "${(article.excerpt || '').replace(/"/g, '\\"')}"
tags: [${(article.keywords || []).map(k => `"${k}"`).join(', ')}]
---

`;
    options.frontmatter = llmFrontmatter;
  } else if (options.includeTemplate) {
    options.frontmatter = textReplace(options.frontmatter, article) + '\n';
    options.backmatter = '\n' + textReplace(options.backmatter, article);
  } else {
    options.frontmatter = options.backmatter = '';
  }
  
  if (!options.llmOptimized && options.includeTemplate) {
    options.backmatter = '\n' + textReplace(options.backmatter, article);
  } else {
    options.backmatter = '';
  }
  
  options.imagePrefix = textReplace(options.imagePrefix, article, options.disallowedChars)
    .split('/').map(s=>generateValidFileName(s, options.disallowedChars)).join('/');
  let result = await turndown(article.content, options, article);
  if (options.downloadImages && options.downloadMode == 'downloadsApi') {
    result = await preDownloadImages(result.imageList, result.markdown);
  }
  return result;
}

function generateValidFileName(title, disallowedChars = null) {
  if (!title) return 'untitled';
  
  title = title + '';
  
  // Don't process if this looks like a template (contains curly braces)
  if (title.includes('{') && title.includes('}')) {
    return title;
  }
  
  // Remove illegal characters for filenames
  var illegalRe = /[\/\?<>\\:\*\|":]/g;
  var name = title.replace(illegalRe, "")
    .replace(new RegExp('\u00A0', 'g'), ' ')  // Replace non-breaking spaces
    .replace(new RegExp(/\s+/, 'g'), ' ')     // Replace multiple spaces with single space
    .trim();
  
  // Remove user-defined disallowed characters (but be more careful)
  if (disallowedChars) {
    for (let c of disallowedChars) {
      // Skip characters that might be part of templates
      if (c === '{' || c === '}') continue;
      
      if (`[\\^$.|?*+()`.includes(c)) c = `\\${c}`;
      name = name.replace(new RegExp(c, 'g'), '');
    }
  }
  
  // Ensure the filename is not empty after cleaning
  if (!name || name.trim() === '') {
    name = 'untitled';
  }
  
  // Limit filename length to avoid filesystem issues
  if (name.length > 200) {
    name = name.substring(0, 200).trim();
  }
  
  // Remove leading/trailing dots and spaces which can cause issues
  name = name.replace(/^[.\s]+|[.\s]+$/g, '');
  
  // Final check - if still empty, use default
  if (!name) {
    name = 'untitled';
  }
  
  return name;
}

async function preDownloadImages(imageList, markdown) {
  const options = await getOptions();
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.runtime.onMessage.removeListener(listener);
      reject(new Error('Image pre-download operation timed out'));
    }, 60000); // 60 second timeout for image downloads

    const listener = (message) => {
      if (message.type === 'predownload-images-result') {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve({ imageList: message.imageList, markdown: message.markdown });
        }
      }
    };
    
    browser.runtime.onMessage.addListener(listener);
    
    try {
      browser.runtime.sendMessage({
        target: 'offscreen',
        type: 'predownload-images',
        imageList: imageList,
        markdown: markdown,
        options: options
      }).catch((error) => {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        reject(error);
      });
    } catch (error) {
      clearTimeout(timeout);
      browser.runtime.onMessage.removeListener(listener);
      reject(error);
    }
  });
}

async function createDownloadUrl(markdown) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.runtime.onMessage.removeListener(listener);
      reject(new Error('Create download URL operation timed out'));
    }, 30000); // 30 second timeout

    const listener = (message) => {
      if (message.type === 'create-download-url-result') {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.url);
        }
      }
    };
    
    browser.runtime.onMessage.addListener(listener);
    
    try {
      browser.runtime.sendMessage({
        target: 'offscreen',
        type: 'create-download-url',
        markdown: markdown
      }).catch((error) => {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        reject(error);
      });
    } catch (error) {
      clearTimeout(timeout);
      browser.runtime.onMessage.removeListener(listener);
      reject(error);
    }
  });
}

async function downloadMarkdown(markdown, title, tabId, imageList = {}, mdClipsFolder = '') {
  const options = await getOptions();
  if (options.downloadMode == 'downloadsApi' && browser.downloads) {
    try {
      const url = await createDownloadUrl(markdown);
      if(mdClipsFolder && !mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
      
      // Ensure the filename is valid
      const sanitizedTitle = generateValidFileName(title, options.disallowedChars);
      const filename = mdClipsFolder + sanitizedTitle + ".md";
      
      // Additional filename validation
      if (!filename || filename.trim() === '' || filename === '.md') {
        throw new Error('Invalid filename generated');
      }
      
      const id = await browser.downloads.download({
        url: url,
        filename: filename,
        saveAs: options.saveAs
      });
      browser.downloads.onChanged.addListener(downloadListener(id, url));
      if (options.downloadImages) {
        let destPath = mdClipsFolder;
        if (sanitizedTitle.includes('/')) {
          destPath += sanitizedTitle.substring(0, sanitizedTitle.lastIndexOf('/'));
        }
        if(destPath && !destPath.endsWith('/')) destPath += '/';
        Object.entries(imageList).forEach(async ([src, filename]) => {
          const sanitizedImageFilename = generateValidFileName(filename, options.disallowedChars);
          const imgId = await browser.downloads.download({
            url: src,
            filename: destPath ? destPath + sanitizedImageFilename : sanitizedImageFilename,
            saveAs: false
          });
          browser.downloads.onChanged.addListener(downloadListener(imgId, src));
        });
      }
    }
    catch (err) {
      console.error("Download failed", err);
    }
  }
  else {
    try {
      await ensureScripts(tabId);
      const filename = mdClipsFolder + generateValidFileName(title, options.disallowedChars) + ".md";
      const code = `downloadMarkdown("${filename}","${base64EncodeUnicode(markdown)}");`;
      await browser.scripting.executeScript({target: {tabId: tabId}, func: (code) => {
        const script = document.createElement('script');
        script.textContent = code;
        (document.head||document.documentElement).appendChild(script);
        script.remove();
      }, args: [code]});
    }
    catch (error) {
      console.error("Failed to execute script: " + error);
    };
  }
}

function downloadListener(id, url) {
  const self = (delta) => {
    if (delta.id === id && delta.state && delta.state.current == "complete") {
      browser.downloads.onChanged.removeListener(self);
      // URL.revokeObjectURL is not available in service worker, 
      // but the URL will be cleaned up automatically when the extension unloads
    }
  }
  return self;
}

function base64EncodeUnicode(str) {
  const utf8Bytes = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (match, p1) {
    return String.fromCharCode('0x' + p1);
  });
  return btoa(utf8Bytes);
}

async function notify(message) {
  const options = await getOptions();
  if (message.type == "clip") {
    const article = await getArticleFromDom(message.dom);
    
    // Add the tab URL to the article object for more reliable URL retrieval
    if (message.tabUrl) {
      article.tabUrl = message.tabUrl;
    }
    
    if (message.selection && message.clipSelection) {
      article.content = message.selection;
    }
    const { markdown, imageList } = await convertArticleToMarkdown(article);
    article.title = await formatTitle(article);
    const mdClipsFolder = await formatMdClipsFolder(article);
    await browser.runtime.sendMessage({ type: "display.md", markdown: markdown, article: article, imageList: imageList, mdClipsFolder: mdClipsFolder});
  }
  else if (message.type == "download") {
    try {
      await downloadMarkdown(message.markdown, message.title, message.tab.id, message.imageList, message.mdClipsFolder);
    } catch (error) {
      console.error("Download failed:", error);
    }
  }
}

browser.commands.onCommand.addListener(function (command) {
  browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
    const tab = tabs[0];
    if (command == "download_tab_as_markdown") {
      const info = { menuItemId: "download-markdown-all" };
      downloadMarkdownFromContext(info, tab);
    }
    else if (command == "copy_tab_as_markdown") {
      const info = { menuItemId: "copy-markdown-all" };
      copyMarkdownFromContext(info, tab);
    }
    else if (command == "copy_selection_as_markdown") {
      const info = { menuItemId: "copy-markdown-selection" };
      copyMarkdownFromContext(info, tab);
    }
    else if (command == "copy_tab_as_markdown_link") {
      copyTabAsMarkdownLink(tab);
    }
    else if (command == "copy_selected_tab_as_markdown_link") {
      copySelectedTabAsMarkdownLink(tab);
    }
    else if (command == "copy_selection_to_obsidian") {
      const info = { menuItemId: "copy-markdown-obsidian" };
      copyMarkdownFromContext(info, tab);
    }
    else if (command == "copy_tab_to_obsidian") {
      const info = { menuItemId: "copy-markdown-obsall" };
      copyMarkdownFromContext(info, tab);
    }
  });
});

browser.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId.startsWith("copy-markdown")) {
    copyMarkdownFromContext(info, tab);
  }
  else if (info.menuItemId == "download-markdown-alltabs" || info.menuItemId == "tab-download-markdown-alltabs") {
    downloadMarkdownForAllTabs(info);
  }
  else if (info.menuItemId.startsWith("download-markdown")) {
    downloadMarkdownFromContext(info, tab);
  }
  else if (info.menuItemId.startsWith("copy-tab-as-markdown-link-all")) {
    copyTabAsMarkdownLinkAll(tab);
  }
  else if (info.menuItemId.startsWith("copy-tab-as-markdown-link-selected")) {
    copySelectedTabAsMarkdownLink(tab);
  }
  else if (info.menuItemId.startsWith("copy-tab-as-markdown-link")) {
    copyTabAsMarkdownLink(tab);
  }
  else if (info.menuItemId.startsWith("toggle-") || info.menuItemId.startsWith("tabtoggle-")) {
    toggleSetting(info.menuItemId.split('-')[1]);
  }
});

async function toggleSetting(setting, options = null) {
  if (options == null) {
      await toggleSetting(setting, await getOptions());
  }
  else {
    options[setting] = !options[setting];
    await browser.storage.sync.set(options);
    if (setting == "includeTemplate") {
      browser.contextMenus.update("toggle-includeTemplate", {
        checked: options.includeTemplate
      });
      try {
        browser.contextMenus.update("tabtoggle-includeTemplate", {
          checked: options.includeTemplate
        });
      } catch { }
    }
    
    if (setting == "downloadImages") {
      browser.contextMenus.update("toggle-downloadImages", {
        checked: options.downloadImages
      });
      try {
        browser.contextMenus.update("tabtoggle-downloadImages", {
          checked: options.downloadImages
        });
      } catch { }
    }
  }
}

async function ensureScripts(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tabId },
      func: () => typeof getSelectionAndDom === "function",
    });
    if (!results || results[0].result !== true) {
      await browser.scripting.executeScript({
        target: { tabId: tabId },
        files: ["/contentScript/contentScript.js"],
      });
    }
  } catch (e) {
    console.error("MarkDownload has no permission to inject a script into the page.", e);
  }
}

let creating; // A global promise to avoid concurrency issues
let offscreenReady = false;

async function ensureOffscreenDocument() {
  if (creating) {
    await creating;
    return;
  }
  
  if (offscreenReady) {
    return;
  }

  try {
    // Check if offscreen document already exists
    const existingContexts = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (existingContexts.length > 0) {
      offscreenReady = true;
      return;
    }
  } catch (e) {
    // getContexts might not be available in all browsers, continue with creation
  }

  creating = browser.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Parse DOM string to get article content',
  }).then(() => {
    offscreenReady = true;
    creating = null;
  }).catch((error) => {
    creating = null;
    if (error.message && error.message.includes('Only a single offscreen document may be created')) {
      // Document already exists, mark as ready
      offscreenReady = true;
    } else {
      throw error;
    }
  });
  
  await creating;
}

async function getArticleFromDom(domString) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.runtime.onMessage.removeListener(listener);
      reject(new Error('DOM parsing operation timed out'));
    }, 30000); // 30 second timeout

    const listener = (message) => {
      if (message.type === 'parse-dom-result') {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        resolve(message.article);
      }
    };
    
    browser.runtime.onMessage.addListener(listener);
    
    try {
      browser.runtime.sendMessage({
        target: 'offscreen',
        type: 'parse-dom',
        domString: domString,
      }).catch((error) => {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        reject(error);
      });
    } catch (error) {
      clearTimeout(timeout);
      browser.runtime.onMessage.removeListener(listener);
      reject(error);
    }
  });
}

async function getArticleFromContent(tabId, selection = false) {
  await ensureScripts(tabId);
  const results = await browser.scripting.executeScript({
    target: { tabId: tabId },
    func: () => getSelectionAndDom(),
  });
  if (results && results[0] && results[0].result.dom) {
    const article = await getArticleFromDom(results[0].result.dom, selection);
    if (selection && results[0].result.selection) {
      article.content = results[0].result.selection;
    }
    return article;
  } else return null;
}

async function formatTitle(article) {
  let options = await getOptions();
  
  // Debug: log the article properties and title template
  console.log('Article properties:', Object.keys(article));
  console.log('Article title:', article.title);
  console.log('Article pageTitle:', article.pageTitle);
  console.log('Title template:', options.title);
  
  // Ensure we have a title to work with
  if (!article.title && !article.pageTitle) {
    // Try to get title from other sources
    article.title = article.siteName || 'Untitled';
  }
  
  // Make sure pageTitle is available for the template
  if (!article.pageTitle && article.title) {
    article.pageTitle = article.title;
  }
  
  let title = textReplace(options.title, article, options.disallowedChars + '/');
  console.log('Title after textReplace:', title);
  
  title = title.split('/').map(s=>generateValidFileName(s, options.disallowedChars)).join('/');
  console.log('Final title:', title);
  
  return title;
}

async function formatMdClipsFolder(article) {
  let options = await getOptions();
  let mdClipsFolder = '';
  if (options.mdClipsFolder && options.downloadMode == 'downloadsApi') {
    mdClipsFolder = textReplace(options.mdClipsFolder, article, options.disallowedChars);
    mdClipsFolder = mdClipsFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
  }
  return mdClipsFolder;
}

async function formatObsidianFolder(article) {
  let options = await getOptions();
  let obsidianFolder = '';
  if (options.obsidianFolder) {
    obsidianFolder = textReplace(options.obsidianFolder, article, options.disallowedChars);
    obsidianFolder = obsidianFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!obsidianFolder.endsWith('/')) obsidianFolder += '/';
  }
  return obsidianFolder;
}

async function downloadMarkdownFromContext(info, tab) {
  await ensureScripts(tab.id);
  const article = await getArticleFromContent(tab.id, info.menuItemId == "download-markdown-selection");
  const title = await formatTitle(article);
  const { markdown, imageList } = await convertArticleToMarkdown(article);
  const mdClipsFolder = await formatMdClipsFolder(article);
  await downloadMarkdown(markdown, title, tab.id, imageList, mdClipsFolder); 
}

async function copyTabAsMarkdownLink(tab) {
  try {
    const article = await getArticleFromContent(tab.id);
    const title = await formatTitle(article);
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: (text) => navigator.clipboard.writeText(text),
      args: [`[${title}](${article.baseURI})`],
    });
  } catch (error) {
    console.error("Failed to copy as markdown link: " + error);
  }
}

async function copyTabAsMarkdownLinkAll() {
  try {
    const options = await getOptions();
    options.frontmatter = options.backmatter = "";
    const tabs = await browser.tabs.query({
      currentWindow: true,
    });
    const links = [];
    for (const tab of tabs) {
      const article = await getArticleFromContent(tab.id);
      const title = await formatTitle(article);
      const link = `${options.bulletListMarker} [${title}](${article.baseURI})`;
      links.push(link);
    }
    const markdown = links.join(`\n`);
    const [{ id: tabId }] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    await browser.scripting.executeScript({
      target: { tabId },
      func: (text) => navigator.clipboard.writeText(text),
      args: [markdown],
    });
  } catch (error) {
    console.error("Failed to copy as markdown link: " + error);
  }
}

async function copySelectedTabAsMarkdownLink() {
  try {
    const options = await getOptions();
    options.frontmatter = options.backmatter = "";
    const tabs = await browser.tabs.query({
      currentWindow: true,
      highlighted: true,
    });
    const links = [];
    for (const tab of tabs) {
      const article = await getArticleFromContent(tab.id);
      const title = await formatTitle(article);
      const link = `${options.bulletListMarker} [${title}](${article.baseURI})`;
      links.push(link);
    }
    const markdown = links.join(`\n`);
    const [{ id: tabId }] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    await browser.scripting.executeScript({
      target: { tabId },
      func: (text) => navigator.clipboard.writeText(text),
      args: [markdown],
    });
  } catch (error) {
    console.error("Failed to copy as markdown link: " + error);
  }
}

async function copyMarkdownFromContext(info, tab) {
  try {
    const platformInfo = await browser.runtime.getPlatformInfo();
    var folderSeparator = "/";
    if (platformInfo.os === "win") {
      folderSeparator = "\\";
    }
    if (info.menuItemId == "copy-markdown-link") {
      const options = await getOptions();
      options.frontmatter = options.backmatter = "";
      const article = await getArticleFromContent(tab.id, false);
      const { markdown } = await turndown(
        `<a href="${info.linkUrl}">${info.linkText || info.selectionText}</a>`,
        { ...options, downloadImages: false },
        article
      );
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (text) => navigator.clipboard.writeText(text),
        args: [markdown],
      });
    } else if (info.menuItemId == "copy-markdown-image") {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (text) => navigator.clipboard.writeText(text),
        args: [`![](${info.srcUrl})`],
      });
    } else if (info.menuItemId == "copy-markdown-obsidian") {
      const article = await getArticleFromContent(
        tab.id,
        info.menuItemId == "copy-markdown-obsidian"
      );
      const title = await formatTitle(article);
      const options = await getOptions();
      const obsidianVault = options.obsidianVault;
      const obsidianFolder = await formatObsidianFolder(article);
      const { markdown } = await convertArticleToMarkdown(
        article,
        (downloadImages = false)
      );
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (text) => navigator.clipboard.writeText(text),
        args: [markdown],
      });
      await browser.tabs.update({
        url:
          "obsidian://advanced-uri?vault=" +
          obsidianVault +
          "&clipboard=true&mode=new&filepath=" +
          obsidianFolder +
          generateValidFileName(title),
      });
    } else if (info.menuItemId == "copy-markdown-obsall") {
      const article = await getArticleFromContent(
        tab.id,
        info.menuItemId == "copy-markdown-obsall"
      );
      const title = await formatTitle(article);
      const options = await getOptions();
      const obsidianVault = options.obsidianVault;
      const obsidianFolder = await formatObsidianFolder(article);
      const { markdown } = await convertArticleToMarkdown(
        article,
        (downloadImages = false)
      );
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (text) => navigator.clipboard.writeText(text),
        args: [markdown],
      });
      await browser.tabs.update({
        url:
          "obsidian://advanced-uri?vault=" +
          obsidianVault +
          "&clipboard=true&mode=new&filepath=" +
          obsidianFolder +
          generateValidFileName(title),
      });
    } else {
      const article = await getArticleFromContent(
        tab.id,
        info.menuItemId == "copy-markdown-selection"
      );
      const { markdown } = await convertArticleToMarkdown(
        article,
        (downloadImages = false)
      );
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (text) => navigator.clipboard.writeText(text),
        args: [markdown],
      });
    }
  } catch (error) {
    console.error("Failed to copy text: " + error);
  }
}

async function downloadMarkdownForAllTabs(info) {
  const tabs = await browser.tabs.query({
    currentWindow: true
  });
  tabs.forEach(tab => {
    downloadMarkdownFromContext(info, tab);
  });
}

if (!String.prototype.replaceAll) {
	String.prototype.replaceAll = function(str, newStr){
		if (Object.prototype.toString.call(str).toLowerCase() === '[object regexp]') {
			return this.replace(str, newStr);
		}
		return this.replace(new RegExp(str, 'g'), newStr);
	};
}
