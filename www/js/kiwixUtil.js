'use strict';
define(['jquery', 'q', 'zimArchiveLoader', 'uiUtil', 'cookies'],
    function ($, Q, zimArchiveLoader, uiUtil, cookies) {

        var expectedArticleURLToBeDisplayed = "";
        var contentInjectionMode;
        var serviceWorkerRegistration = null;
        var cssCache = new Map();
        var selectedArchive = null;
        var contentInjectionMode;
        var keepAliveServiceWorkerHandle;
        var messageChannel;
        var expectedArticleURLToBeDisplayed = "";


        /**
 * The name of the Cache API cache to use for caching Service Worker requests and responses for certain asset types
 * This name will be passed to service-worker.js in messaging to avoid duplication: see comment in service-worker.js
 * We need access to this constant in app.js in order to complete utility actions when Service Worker is not initialized 
 * @type {String}
 */
        var CACHE_NAME = 'kiwixjs-assetCache';
        /**
     * The delay (in milliseconds) between two "keepalive" messages
     * sent to the ServiceWorker (so that it is not stopped by
     * the browser, and keeps the MessageChannel to communicate
     * with the application)
     * @type Integer
     */
        var DELAY_BETWEEN_KEEPALIVE_SERVICEWORKER = 30000;

        var kiwixUtil = {};

        /**
     * Check whether the given URL from given dirEntry equals the expectedArticleURLToBeDisplayed
     * @param {DirEntry} dirEntry The directory entry of the article to read
     */
        kiwixUtil.isDirEntryExpectedToBeDisplayed = function (dirEntry) {
            var curArticleURL = dirEntry.namespace + "/" + dirEntry.url;

            if (expectedArticleURLToBeDisplayed !== curArticleURL) {
                console.debug("url of current article :" + curArticleURL + ", does not match the expected url :" +
                    expectedArticleURLToBeDisplayed);
                return false;
            }
            return true;
        };

        /**
         * Resize the IFrame height, so that it fills the whole available height in the window
         */
        kiwixUtil.resizeIFrame = function () {
            var headerStyles = getComputedStyle(document.getElementById('top'));
            var iframe = document.getElementById('articleContent');
            var region = document.getElementById('search-article');
            if (iframe.style.display === 'none') {
                // We are in About or Configuration, so we only set the region height
                region.style.height = window.innerHeight + 'px';
            } else {
                // IE cannot retrieve computed headerStyles till the next paint, so we wait a few ticks
                setTimeout(function () {
                    // Get  header height *including* its bottom margin
                    var headerHeight = parseFloat(headerStyles.height) + parseFloat(headerStyles.marginBottom);
                    iframe.style.height = window.innerHeight - headerHeight + 'px';
                    // We have to allow a minimum safety margin of 10px for 'iframe' and 'header' to fit within 'region'
                    region.style.height = window.innerHeight + 10 + 'px';
                }, 100);
            }
        };


        /**
     * Sets the given injection mode.
     * This involves registering (or re-enabling) the Service Worker if necessary
     * It also refreshes the API status for the user afterwards.
     * 
     * @param {String} value The chosen content injection mode : 'jquery' or 'serviceworker'
     */
        kiwixUtil.setContentInjectionMode = function (value) {
            if (value === 'jquery') {
                if (kiwixUtil.isServiceWorkerReady()) {
                    // We need to disable the ServiceWorker
                    // Unregistering it does not seem to work as expected : the ServiceWorker
                    // is indeed unregistered but still active...
                    // So we have to disable it manually (even if it's still registered and active)
                    serviceWorkerRegistration.active.postMessage({ 'action': 'disable' });
                    messageChannel = null;
                }
                kiwixUtil.refreshAPIStatus();
                // User has switched to jQuery mode, so no longer needs CACHE_NAME
                // We should empty it to prevent unnecessary space usage
                if ('caches' in window) caches.delete(this.CACHE_NAME);
            } else if (value === 'serviceworker') {
                if (!kiwixUtil.isServiceWorkerAvailable()) {
                    alert("The ServiceWorker API is not available on your device. Falling back to JQuery mode");
                    kiwixUtil.setContentInjectionMode('jquery');
                    return;
                }
                if (!kiwixUtil.isMessageChannelAvailable()) {
                    alert("The MessageChannel API is not available on your device. Falling back to JQuery mode");
                    kiwixUtil.setContentInjectionMode('jquery');
                    return;
                }

                if (!kiwixUtil.isServiceWorkerReady()) {
                    $('#serviceWorkerStatus').html("ServiceWorker API available : trying to register it...");
                    navigator.serviceWorker.register('../../service-worker.js').then(function (reg) {
                        // The ServiceWorker is registered
                        serviceWorkerRegistration = reg;
                        kiwixUtil.refreshAPIStatus();

                        // We need to wait for the ServiceWorker to be activated
                        // before sending the first init message
                        var serviceWorker = reg.installing || reg.waiting || reg.active;
                        serviceWorker.addEventListener('statechange', function (statechangeevent) {
                            if (statechangeevent.target.state === 'activated') {
                                // Remove any jQuery hooks from a previous jQuery session
                                $('#articleContent').contents().remove();
                                // Create the MessageChannel
                                // and send the 'init' message to the ServiceWorker
                                kiwixUtil.initOrKeepAliveServiceWorker();
                                // We need to refresh cache status here on first activation because SW was inaccessible till now
                                // We also initialize the CACHE_NAME constant in SW here
                                kiwixUtil.refreshCacheStatus();
                            }
                        });
                        if (serviceWorker.state === 'activated') {
                            // Even if the ServiceWorker is already activated,
                            // We need to re-create the MessageChannel
                            // and send the 'init' message to the ServiceWorker
                            // in case it has been stopped and lost its context
                            kiwixUtil.initOrKeepAliveServiceWorker();
                        }
                    }, function (err) {
                        console.error('error while registering serviceWorker', err);
                        kiwixUtil.refreshAPIStatus();
                        var message = "The ServiceWorker could not be properly registered. Switching back to jQuery mode. Error message : " + err;
                        var protocol = window.location.protocol;
                        if (protocol === 'moz-extension:') {
                            message += "\n\nYou seem to be using kiwix-js through a Firefox extension : ServiceWorkers are disabled by Mozilla in extensions.";
                            message += "\nPlease vote for https://bugzilla.mozilla.org/show_bug.cgi?id=1344561 so that some future Firefox versions support it";
                        }
                        else if (protocol === 'file:') {
                            message += "\n\nYou seem to be opening kiwix-js with the file:// protocol. You should open it through a web server : either through a local one (http://localhost/...) or through a remote one (but you need SSL : https://webserver/...)";
                        }
                        alert(message);
                        kiwixUtil.setContentInjectionMode("jquery");
                        return;
                    });
                } else {
                    // We need to set this variable earlier else the ServiceWorker does not get reactivated
                    contentInjectionMode = value;
                    kiwixUtil.initOrKeepAliveServiceWorker();
                }
                // User has switched to Service Worker mode, so no longer needs the memory cache
                // We should empty it to ensure good memory management
                kiwixUtil.resetCssCache();
            }
            $('input:radio[name=contentInjectionMode]').prop('checked', false);
            $('input:radio[name=contentInjectionMode]').filter('[value="' + value + '"]').prop('checked', true);
            contentInjectionMode = value;
            // Save the value in a cookie, so that to be able to keep it after a reload/restart
            cookies.setItem('lastContentInjectionMode', value, Infinity);
            kiwixUtil.refreshCacheStatus();
        };

        /**
         * Displays or refreshes the API status shown to the user
         */
        kiwixUtil.refreshAPIStatus = function () {
            var apiStatusPanel = document.getElementById('apiStatusDiv');
            apiStatusPanel.classList.remove('card-success', 'card-warning');
            var apiPanelClass = 'card-success';
            if (kiwixUtil.isMessageChannelAvailable()) {
                $('#messageChannelStatus').html("MessageChannel API available");
                $('#messageChannelStatus').removeClass("apiAvailable apiUnavailable")
                    .addClass("apiAvailable");
            } else {
                apiPanelClass = 'card-warning';
                $('#messageChannelStatus').html("MessageChannel API unavailable");
                $('#messageChannelStatus').removeClass("apiAvailable apiUnavailable")
                    .addClass("apiUnavailable");
            }
            if (kiwixUtil.isServiceWorkerAvailable()) {
                if (kiwixUtil.isServiceWorkerReady()) {
                    $('#serviceWorkerStatus').html("ServiceWorker API available, and registered");
                    $('#serviceWorkerStatus').removeClass("apiAvailable apiUnavailable")
                        .addClass("apiAvailable");
                } else {
                    apiPanelClass = 'card-warning';
                    $('#serviceWorkerStatus').html("ServiceWorker API available, but not registered");
                    $('#serviceWorkerStatus').removeClass("apiAvailable apiUnavailable")
                        .addClass("apiUnavailable");
                }
            } else {
                apiPanelClass = 'card-warning';
                $('#serviceWorkerStatus').html("ServiceWorker API unavailable");
                $('#serviceWorkerStatus').removeClass("apiAvailable apiUnavailable")
                    .addClass("apiUnavailable");
            }
            apiStatusPanel.classList.add(apiPanelClass);
        };

        /**
     * Tells if the ServiceWorker API is available
     * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorker
     * @returns {Boolean}
     */
        kiwixUtil.isServiceWorkerAvailable = function () {
            return ('serviceWorker' in navigator);
        };

        /**
         * Tells if the MessageChannel API is available
         * https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel
         * @returns {Boolean}
         */
        kiwixUtil.isMessageChannelAvailable = function () {
            try {
                var dummyMessageChannel = new MessageChannel();
                if (dummyMessageChannel) return true;
            }
            catch (e) {
                return false;
            }
            return false;
        };

        /**
         * Tells if the ServiceWorker is registered, and ready to capture HTTP requests
         * and inject content in articles.
         * @returns {Boolean}
         */
        kiwixUtil.isServiceWorkerReady = function () {
            // Return true if the serviceWorkerRegistration is not null and not undefined
            return (serviceWorkerRegistration);
        };

        /** 
     * Refreshes the UI (Configuration) with the cache attributes obtained from getCacheAttributes()
     */
        kiwixUtil.refreshCacheStatus = function () {
            // Update radio buttons and checkbox
            document.getElementById('cachedAssetsModeRadio' + (params.useCache ? 'True' : 'False')).checked = true;
            // Get cache attributes, then update the UI with the obtained data
            kiwixUtil.getCacheAttributes().then(function (cache) {
                document.getElementById('cacheUsed').innerHTML = cache.description;
                document.getElementById('assetsCount').innerHTML = cache.count;
                var cacheSettings = document.getElementById('cacheSettingsDiv');
                var cacheStatusPanel = document.getElementById('cacheStatusPanel');
                [cacheSettings, cacheStatusPanel].forEach(function (card) {
                    // IE11 cannot remove more than one class from a list at a time
                    card.classList.remove('card-success');
                    card.classList.remove('card-warning');
                    if (params.useCache) card.classList.add('card-success');
                    else card.classList.add('card-warning');
                });
            });
        };


        /**
     * Queries Service Worker if possible to determine cache capability and returns an object with cache attributes
     * If Service Worker is not available, the attributes of the memory cache are returned instead
     * @returns {Promise<Object>} A Promise for an object with cache attributes 'type', 'description', and 'count'
     */
        kiwixUtil.getCacheAttributes = function () {
            return Q.Promise(function (resolve, reject) {
                if (contentInjectionMode === 'serviceworker') {
                    // Create a Message Channel
                    var channel = new MessageChannel();
                    // Handler for recieving message reply from service worker
                    channel.port1.onmessage = function (event) {
                        var cache = event.data;
                        if (cache.error) reject(cache.error);
                        else resolve(cache);
                    };
                    // Ask Service Worker for its cache status and asset count
                    serviceWorkerRegistration.active.postMessage({
                        'action': {
                            'useCache': params.useCache ? 'on' : 'off',
                            'checkCache': window.location.href
                        },
                        'cacheName': CACHE_NAME
                    }, [channel.port2]);
                } else {
                    // No Service Worker has been established, so we resolve the Promise with cssCache details only
                    resolve({
                        'type': params.useCache ? 'memory' : 'none',
                        'description': params.useCache ? 'Memory' : 'None',
                        'count': cssCache.size
                    });
                }
            });
        };

        /**
     * Sets the localArchive from the selected archive in the drop-down list
     */
        kiwixUtil.setLocalArchiveFromArchiveList = function () {
            var archiveDirectory = $('#archiveList').val();
            if (archiveDirectory && archiveDirectory.length > 0) {
                // Now, try to find which DeviceStorage has been selected by the user
                // It is the prefix of the archive directory
                var regexpStorageName = /^\/([^/]+)\//;
                var regexpResults = regexpStorageName.exec(archiveDirectory);
                var selectedStorage = null;
                if (regexpResults && regexpResults.length > 0) {
                    var selectedStorageName = regexpResults[1];
                    for (var i = 0; i < storages.length; i++) {
                        var storage = storages[i];
                        if (selectedStorageName === storage.storageName) {
                            // We found the selected storage
                            selectedStorage = storage;
                        }
                    }
                    if (selectedStorage === null) {
                        alert("Unable to find which device storage corresponds to directory " + archiveDirectory);
                    }
                }
                else {
                    // This happens when the archiveDirectory is not prefixed by the name of the storage
                    // (in the Simulator, or with FxOs 1.0, or probably on devices that only have one device storage)
                    // In this case, we use the first storage of the list (there should be only one)
                    if (storages.length === 1) {
                        selectedStorage = storages[0];
                    }
                    else {
                        alert("Something weird happened with the DeviceStorage API : found a directory without prefix : "
                            + archiveDirectory + ", but there were " + storages.length
                            + " storages found with getDeviceStorages instead of 1");
                    }
                }
                kiwixUtil.resetCssCache();
                selectedArchive = zimArchiveLoader.loadArchiveFromDeviceStorage(selectedStorage, archiveDirectory, function (archive) {
                    cookies.setItem("lastSelectedArchive", archiveDirectory, Infinity);
                    // The archive is set : go back to home page to start searching
                    $("#btnHome").click();
                });
            }
        };
        /**
         * Resets the CSS Cache (used only in jQuery mode)
         */
        kiwixUtil.resetCssCache = function () {
            // Reset the cssCache. Must be done when archive changes.
            if (cssCache) {
                cssCache = new Map();
            }
        };

        kiwixUtil.setLocalArchiveFromFileList = function (files) {
            // Check for usable file types
            for (var i = files.length; i--;) {
                // DEV: you can support other file types by adding (e.g.) '|dat|idx' after 'zim\w{0,2}'
                if (!/\.(?:zim\w{0,2})$/i.test(files[i].name)) {
                    alert("One or more files does not appear to be a ZIM file!");
                    return;
                }
            }
            kiwixUtil.resetCssCache();
            selectedArchive = zimArchiveLoader.loadArchiveFromFiles(files, function (archive) {
                // The archive is set : go back to home page to start searching
                $("#btnHome").click();
                document.getElementById('downloadInstruction').style.display = 'none';
            });
        };

        kiwixUtil.getSelectedArchive = function () {
            return selectedArchive;
        };

        /**
         * Sets the localArchive from the File selects populated by user
         */
        kiwixUtil.setLocalArchiveFromFileSelect = function () {
            kiwixUtil.setLocalArchiveFromFileList(document.getElementById('archiveFiles').files);
        };

        /**
         * Send an 'init' message to the ServiceWorker with a new MessageChannel
         * to initialize it, or to keep it alive.
         * This MessageChannel allows a 2-way communication between the ServiceWorker
         * and the application
         */
        kiwixUtil.initOrKeepAliveServiceWorker = function () {
            if (contentInjectionMode === 'serviceworker') {
                // Create a new messageChannel
                var tmpMessageChannel = new MessageChannel();
                tmpMessageChannel.port1.onmessage = kiwixUtil.handleMessageChannelMessage;
                // Send the init message to the ServiceWorker, with this MessageChannel as a parameter
                serviceWorkerRegistration.active.postMessage({ 'action': 'init' }, [tmpMessageChannel.port2]);
                messageChannel = tmpMessageChannel;
                // Schedule to do it again regularly to keep the 2-way communication alive.
                // See https://github.com/kiwix/kiwix-js/issues/145 to understand why
                clearTimeout(keepAliveServiceWorkerHandle);
                keepAliveServiceWorkerHandle = setTimeout(kiwixUtil.initOrKeepAliveServiceWorker, DELAY_BETWEEN_KEEPALIVE_SERVICEWORKER, false);
            }
        };

        var messageChannel;

        /**
         * Function that handles a message of the messageChannel.
         * It tries to read the content in the backend, and sends it back to the ServiceWorker
         * 
         * @param {Event} event The event object of the message channel
         */
        kiwixUtil.handleMessageChannelMessage = function (event) {
            if (event.data.error) {
                console.error("Error in MessageChannel", event.data.error);
                reject(event.data.error);
            } else {
                // We received a message from the ServiceWorker
                if (event.data.action === "askForContent") {
                    // The ServiceWorker asks for some content
                    var title = event.data.title;
                    var messagePort = event.ports[0];
                    var readFile = function (dirEntry) {
                        if (dirEntry === null) {
                            console.error("Title " + title + " not found in archive.");
                            messagePort.postMessage({ 'action': 'giveContent', 'title': title, 'content': '' });
                        } else if (dirEntry.isRedirect()) {
                            selectedArchive.resolveRedirect(dirEntry, function (resolvedDirEntry) {
                                var redirectURL = resolvedDirEntry.namespace + "/" + resolvedDirEntry.url;
                                // Ask the ServiceWork to send an HTTP redirect to the browser.
                                // We could send the final content directly, but it is necessary to let the browser know in which directory it ends up.
                                // Else, if the redirect URL is in a different directory than the original URL,
                                // the relative links in the HTML content would fail. See #312
                                messagePort.postMessage({ 'action': 'sendRedirect', 'title': title, 'redirectUrl': redirectURL });
                            });
                        } else {
                            // Let's read the content in the ZIM file
                            selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                                var mimetype = fileDirEntry.getMimetype();
                                // Let's send the content to the ServiceWorker
                                var message = { 'action': 'giveContent', 'title': title, 'content': content.buffer, 'mimetype': mimetype };
                                messagePort.postMessage(message, [content.buffer]);
                            });
                        }
                    };
                    selectedArchive.getDirEntryByTitle(title).then(readFile).catch(function () {
                        messagePort.postMessage({ 'action': 'giveContent', 'title': title, 'content': new UInt8Array() });
                    });
                } else {
                    console.error("Invalid message received", event.data);
                }
            }
        };

        // Compile some regular expressions needed to modify links
        // Pattern to find a ZIM URL (with its namespace) - see https://wiki.openzim.org/wiki/ZIM_file_format#Namespaces
        var regexpZIMUrlWithNamespace = /^[./]*([-ABIJMUVWX]\/.+)$/;
        // Regex below finds images, scripts, stylesheets and tracks with ZIM-type metadata and image namespaces [kiwix-js #378]
        // It first searches for <img, <script, <link, etc., then scans forward to find, on a word boundary, either src=["']
        // or href=["'] (ignoring any extra whitespace), and it then tests the path of the URL with a non-capturing lookahead that
        // matches ZIM URLs with namespaces [-IJ] ('-' = metadata or 'I'/'J' = image). When the regex is used below, it will also
        // remove any relative or absolute path from ZIM-style URLs.
        // DEV: If you want to support more namespaces, add them to the END of the character set [-IJ] (not to the beginning) 
        var regexpTagsWithZimUrl = /(<(?:img|script|link|track)\b[^>]*?\s)(?:src|href)(\s*=\s*["'])(?:\.\.\/|\/)+(?=[-IJ]\/)/ig;
        // Regex below tests the html of an article for active content [kiwix-js #466]
        // It inspects every <script> block in the html and matches in the following cases: 1) the script loads a UI application called app.js;
        // 2) the script block has inline content that does not contain "importScript()" or "toggleOpenSection" (these strings are used widely
        // in our fully supported wikimedia ZIMs, so they are excluded); 3) the script block is not of type "math" (these are MathJax markup
        // scripts used extensively in Stackexchange ZIMs). Note that the regex will match ReactJS <script type="text/html"> markup, which is
        // common in unsupported packaged UIs, e.g. PhET ZIMs.
        var regexpActiveContent = /<script\b(?:(?![^>]+src\b)|(?=[^>]+src\b=["'][^"']+?app\.js))(?!>[^<]+(?:importScript\(\)|toggleOpenSection))(?![^>]+type\s*=\s*["'](?:math\/|[^"']*?math))/i;

        // DEV: The regex below matches ZIM links (anchor hrefs) that should have the html5 "donwnload" attribute added to 
        // the link. This is currently the case for epub and pdf files in Project Gutenberg ZIMs -- add any further types you need
        // to support to this regex. The "zip" has been added here as an example of how to support further filetypes
        var regexpDownloadLinks = /^.*?\.epub($|\?)|^.*?\.pdf($|\?)|^.*?\.zip($|\?)/i;

        /**
         * Display the the given HTML article in the web page,
         * and convert links to javascript calls
         * NB : in some error cases, the given title can be null, and the htmlArticle contains the error message
         * @param {DirEntry} dirEntry
         * @param {String} htmlArticle
         */
        kiwixUtil.displayArticleContentInIframe = function (dirEntry, htmlArticle) {
            if (!kiwixUtil.isDirEntryExpectedToBeDisplayed(dirEntry)) {
                return;
            }
            // Display Bootstrap warning alert if the landing page contains active content
            if (!params.hideActiveContentWarning && params.isLandingPage) {
                if (regexpActiveContent.test(htmlArticle)) uiUtil.displayActiveContentWarning();
            }

            // Replaces ZIM-style URLs of img, script, link and media tags with a data-kiwixurl to prevent 404 errors [kiwix-js #272 #376]
            // This replacement also processes the URL to remove the path so that the URL is ready for subsequent jQuery functions
            htmlArticle = htmlArticle.replace(regexpTagsWithZimUrl, '$1data-kiwixurl$2');

            // Extract any css classes from the html tag (they will be stripped when injected in iframe with .innerHTML)
            var htmlCSS = htmlArticle.match(/<html[^>]*class\s*=\s*["']\s*([^"']+)/i);
            htmlCSS = htmlCSS ? htmlCSS[1] : '';

            // Tell jQuery we're removing the iframe document: clears jQuery cache and prevents memory leaks [kiwix-js #361]
            $('#articleContent').contents().remove();

            // Hide any alert box that was activated in uiUtil.displayFileDownloadAlert function
            $('#downloadAlert').hide();

            var iframeArticleContent = document.getElementById('articleContent');

            iframeArticleContent.onload = function () {
                iframeArticleContent.onload = function () { };
                $("#articleList").empty();
                $('#articleListHeaderMessage').empty();
                $('#articleListWithHeader').hide();
                $("#prefix").val("");

                var iframeContentDocument = iframeArticleContent.contentDocument;
                if (!iframeContentDocument && window.location.protocol === 'file:') {
                    alert("You seem to be opening kiwix-js with the file:// protocol, which is blocked by your browser for security reasons."
                        + "\nThe easiest way to run it is to download and run it as a browser extension (from the vendor store)."
                        + "\nElse you can open it through a web server : either through a local one (http://localhost/...) or through a remote one (but you need SSL : https://webserver/...)"
                        + "\nAnother option is to force your browser to accept that (but you'll open a security breach) : on Chrome, you can start it with --allow-file-access-from-files command-line argument; on Firefox, you can set privacy.file_unique_origin to false in about:config");
                    return;
                }

                // Inject the new article's HTML into the iframe
                var articleContent = iframeContentDocument.documentElement;
                articleContent.innerHTML = htmlArticle;

                var docBody = articleContent.getElementsByTagName('body');
                docBody = docBody ? docBody[0] : null;
                if (docBody) {
                    // Add any missing classes stripped from the <html> tag
                    if (htmlCSS) docBody.classList.add(htmlCSS);
                    // Deflect drag-and-drop of ZIM file on the iframe to Config
                    docBody.addEventListener('dragover', kiwixUtil.handleIframeDragover);
                    docBody.addEventListener('drop', kiwixUtil.handleIframeDrop);
                }
                // Set the requested appTheme
                uiUtil.applyAppTheme(params.appTheme);
                // Allow back/forward in browser history
                kiwixUtil.pushBrowserHistoryState(dirEntry.namespace + "/" + dirEntry.url);

                parseAnchorsJQuery();
                loadImagesJQuery();
                // JavaScript is currently disabled, so we need to make the browser interpret noscript tags
                // NB : if javascript is properly handled in jQuery mode in the future, this call should be removed
                // and noscript tags should be ignored
                loadNoScriptTags();
                //loadJavaScriptJQuery();
                loadCSSJQuery();
                insertMediaBlobsJQuery();
            };

            // Load the blank article to clear the iframe (NB iframe onload event runs *after* this)
            iframeArticleContent.src = "article.html";

            // Calculate the current article's ZIM baseUrl to use when processing relative links
            var baseUrl = dirEntry.namespace + '/' + dirEntry.url.replace(/[^/]+$/, '');

            function parseAnchorsJQuery() {
                var currentProtocol = location.protocol;
                var currentHost = location.host;
                // Percent-encode dirEntry.url and add regex escape character \ to the RegExp special characters - see https://www.regular-expressions.info/characters.html;
                // NB dirEntry.url can also contain path separator / in some ZIMs (Stackexchange). } and ] do not need to be escaped as they have no meaning on their own. 
                var escapedUrl = encodeURIComponent(dirEntry.url).replace(/([\\$^.|?*+/()[{])/g, '\\$1');
                // Pattern to match a local anchor in an href even if prefixed by escaped url; will also match # on its own
                var regexpLocalAnchorHref = new RegExp('^(?:#|' + escapedUrl + '#)([^#]*$)');
                var iframe = iframeArticleContent.contentDocument;
                Array.prototype.slice.call(iframe.querySelectorAll('a, area')).forEach(function (anchor) {
                    // Attempts to access any properties of 'this' with malformed URLs causes app crash in Edge/UWP [kiwix-js #430]
                    try {
                        var testHref = anchor.href;
                    } catch (err) {
                        console.error('Malformed href caused error:' + err.message);
                        return;
                    }
                    var href = anchor.getAttribute('href');
                    if (href === null || href === undefined) return;
                    if (href.length === 0) {
                        // It's a link with an empty href, pointing to the current page: do nothing.
                    } else if (regexpLocalAnchorHref.test(href)) {
                        // It's a local anchor link : remove escapedUrl if any (see above)
                        anchor.setAttribute('href', href.replace(/^[^#]*/, ''));
                    } else if (anchor.protocol !== currentProtocol ||
                        anchor.host !== currentHost) {
                        // It's an external URL : we should open it in a new tab
                        anchor.target = '_blank';
                    } else {
                        // It's a link to an article or file in the ZIM
                        var uriComponent = uiUtil.removeUrlParameters(href);
                        var contentType;
                        var downloadAttrValue;
                        // Some file types need to be downloaded rather than displayed (e.g. *.epub)
                        // The HTML download attribute can be Boolean or a string representing the specified filename for saving the file
                        // For Boolean values, getAttribute can return any of the following: download="" download="download" download="true"
                        // So we need to test hasAttribute first: see https://developer.mozilla.org/en-US/docs/Web/API/Element/getAttribute
                        // However, we cannot rely on the download attribute having been set, so we also need to test for known download file types
                        var isDownloadableLink = anchor.hasAttribute('download') || regexpDownloadLinks.test(href);
                        if (isDownloadableLink) {
                            downloadAttrValue = anchor.getAttribute('download');
                            // Normalize the value to a true Boolean or a filename string or true if there is no download attribute
                            downloadAttrValue = /^(download|true|\s*)$/i.test(downloadAttrValue) || downloadAttrValue || true;
                            contentType = anchor.getAttribute('type');
                        }
                        // Add an onclick event to extract this article or file from the ZIM
                        // instead of following the link
                        anchor.addEventListener('click', function (e) {
                            var zimUrl = uiUtil.deriveZimUrlFromRelativeUrl(uriComponent, baseUrl);
                            kiwixUtil.goToArticle(zimUrl, downloadAttrValue, contentType);
                            e.preventDefault();
                        });
                    }
                });
            };

            function loadImagesJQuery() {
                $('#articleContent').contents().find('body').find('img[data-kiwixurl]').each(function () {
                    var image = $(this);
                    var imageUrl = image.attr("data-kiwixurl");
                    var title = decodeURIComponent(imageUrl);
                    selectedArchive.getDirEntryByTitle(title).then(function (dirEntry) {
                        selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                            var mimetype = dirEntry.getMimetype();
                            uiUtil.feedNodeWithBlob(image, 'src', content, mimetype);
                        });
                    }).catch(function (e) {
                        console.error("could not find DirEntry for image:" + title, e);
                    });
                });
            };

            function loadNoScriptTags() {
                // For each noscript tag, we replace it with its content, so that the browser interprets it
                $('#articleContent').contents().find('noscript').replaceWith(function () {
                    // When javascript is enabled, browsers interpret the content of noscript tags as text
                    // (see https://html.spec.whatwg.org/multipage/scripting.html#the-noscript-element)
                    // So we can read this content with .textContent
                    return this.textContent;
                });
            };

            function loadCSSJQuery() {
                // Ensure all sections are open for clients that lack JavaScript support, or that have some restrictive CSP [kiwix-js #355].
                // This is needed only for some versions of ZIM files generated by mwoffliner (at least in early 2018), where the article sections are closed by default on small screens.
                // These sections can be opened by clicking on them, but this is done with some javascript.
                // The code below is a workaround we still need for compatibility with ZIM files generated by mwoffliner in 2018.
                // A better fix has been made for more recent ZIM files, with the use of noscript tags : see https://github.com/openzim/mwoffliner/issues/324
                var iframe = document.getElementById('articleContent').contentDocument;
                var collapsedBlocks = iframe.querySelectorAll('.collapsible-block:not(.open-block), .collapsible-heading:not(.open-block)');
                // Using decrementing loop to optimize performance : see https://stackoverflow.com/questions/3520688 
                for (var i = collapsedBlocks.length; i--;) {
                    collapsedBlocks[i].classList.add('open-block');
                }

                var cssCount = 0;
                var cssFulfilled = 0;
                $('#articleContent').contents().find('link[data-kiwixurl]').each(function () {
                    cssCount++;
                    var link = $(this);
                    var linkUrl = link.attr("data-kiwixurl");
                    var title = uiUtil.removeUrlParameters(decodeURIComponent(linkUrl));
                    if (cssCache.has(title)) {
                        var cssContent = cssCache.get(title);
                        uiUtil.replaceCSSLinkWithInlineCSS(link, cssContent);
                        cssFulfilled++;
                    } else {
                        if (params.useCache) $('#cachingAssets').show();
                        selectedArchive.getDirEntryByTitle(title)
                            .then(function (dirEntry) {
                                return selectedArchive.readUtf8File(dirEntry,
                                    function (fileDirEntry, content) {
                                        var fullUrl = fileDirEntry.namespace + "/" + fileDirEntry.url;
                                        if (params.useCache) cssCache.set(fullUrl, content);
                                        uiUtil.replaceCSSLinkWithInlineCSS(link, content);
                                        cssFulfilled++;
                                        renderIfCSSFulfilled(fileDirEntry.url);
                                    }
                                );
                            }).catch(function (e) {
                                console.error("could not find DirEntry for CSS : " + title, e);
                                cssCount--;
                                renderIfCSSFulfilled();
                            });
                    }
                });
                renderIfCSSFulfilled();

                // Some pages are extremely heavy to render, so we prevent rendering by keeping the iframe hidden
                // until all CSS content is available [kiwix-js #381]
                function renderIfCSSFulfilled(title) {
                    if (cssFulfilled >= cssCount) {
                        $('#cachingAssets').html('Caching assets...');
                        $('#cachingAssets').hide();
                        $('#searchingArticles').hide();
                        $('#articleContent').show();
                        // We have to resize here for devices with On Screen Keyboards when loading from the article search list
                        kiwixUtil.resizeIFrame();
                    } else {
                        kiwixUtil.updateCacheStatus(title);
                    }
                }
            }

            function loadJavaScriptJQuery() {
                $('#articleContent').contents().find('script[data-kiwixurl]').each(function () {
                    var script = $(this);
                    var scriptUrl = script.attr("data-kiwixurl");
                    // TODO check that the type of the script is text/javascript or application/javascript
                    var title = uiUtil.removeUrlParameters(decodeURIComponent(scriptUrl));
                    selectedArchive.getDirEntryByTitle(title).then(function (dirEntry) {
                        if (dirEntry === null) {
                            console.log("Error: js file not found: " + title);
                        } else {
                            selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                                // TODO : JavaScript support not yet functional [kiwix-js #152]
                                uiUtil.feedNodeWithBlob(script, 'src', content, 'text/javascript');
                            });
                        }
                    }).catch(function (e) {
                        console.error("could not find DirEntry for javascript : " + title, e);
                    });
                });
            }

            function insertMediaBlobsJQuery() {
                var iframe = iframeArticleContent.contentDocument;
                Array.prototype.slice.call(iframe.querySelectorAll('video, audio, source, track'))
                    .forEach(function (mediaSource) {
                        var source = mediaSource.getAttribute('src');
                        source = source ? uiUtil.deriveZimUrlFromRelativeUrl(source, baseUrl) : null;
                        // We have to exempt text tracks from using deriveZimUrlFromRelativeurl due to a bug in Firefox [kiwix-js #496]
                        source = source ? source : mediaSource.dataset.kiwixurl;
                        if (!source || !regexpZIMUrlWithNamespace.test(source)) {
                            if (source) console.error('No usable media source was found for: ' + source);
                            return;
                        }
                        var mediaElement = /audio|video/i.test(mediaSource.tagName) ? mediaSource : mediaSource.parentElement;
                        selectedArchive.getDirEntryByTitle(decodeURIComponent(source)).then(function (dirEntry) {
                            return selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, mediaArray) {
                                var mimeType = mediaSource.type ? mediaSource.type : dirEntry.getMimetype();
                                var blob = new Blob([mediaArray], { type: mimeType });
                                mediaSource.src = URL.createObjectURL(blob);
                                // In Firefox and Chromium it is necessary to re-register the inserted media source
                                // but do not reload for text tracks (closed captions / subtitles)
                                if (/track/i.test(mediaSource.tagName)) return;
                                mediaElement.load();
                            });
                        });
                    });
            }
        };


        /**
         * Displays a message to the user that a style or other asset is being cached
         * @param {String} title The title of the file to display in the caching message block 
         */
        kiwixUtil.updateCacheStatus = function (title) {
            if (params.useCache && /\.css$|\.js$/i.test(title)) {
                var cacheBlock = document.getElementById('cachingAssets');
                cacheBlock.style.display = 'block';
                title = title.replace(/[^/]+\//g, '').substring(0, 18);
                cacheBlock.innerHTML = 'Caching ' + title + '...';
            }
        };


        kiwixUtil.handleIframeDragover = function (e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'link';
            document.getElementById('btnConfigure').click();
        };

        kiwixUtil.handleIframeDrop = function (e) {
            e.stopPropagation();
            e.preventDefault();
            return;
        };

        /**
     * Changes the URL of the browser page, so that the user might go back to it
     * 
     * @param {String} title
     * @param {String} titleSearch
     */
        kiwixUtil.pushBrowserHistoryState = function (title, titleSearch) {
            var stateObj = {};
            var urlParameters;
            var stateLabel;
            if (title && !("" === title)) {
                // Prevents creating a double history for the same page
                if (history.state && history.state.title === title) return;
                stateObj.title = title;
                urlParameters = "?title=" + title;
                stateLabel = "Wikipedia Article : " + title;
            }
            else if (titleSearch && !("" === titleSearch)) {
                stateObj.titleSearch = titleSearch;
                urlParameters = "?titleSearch=" + titleSearch;
                stateLabel = "Wikipedia search : " + titleSearch;
            }
            else {
                return;
            }
            window.history.pushState(stateObj, stateLabel, urlParameters);
        };


        /**
        * Read the article corresponding to the given dirEntry
        * @param {DirEntry} dirEntry The directory entry of the article to read
        */
        kiwixUtil.readArticle = function (dirEntry) {
            // Only update for expectedArticleURLToBeDisplayed.
            expectedArticleURLToBeDisplayed = dirEntry.namespace + "/" + dirEntry.url;
            // We must remove focus from UI elements in order to deselect whichever one was clicked (in both jQuery and SW modes),
            // but we should not do this when opening the landing page (or else one of the Unit Tests fails, at least on Chrome 58)
            if (!params.isLandingPage) document.getElementById('articleContent').contentWindow.focus();

            if (contentInjectionMode === 'serviceworker') {
                // In ServiceWorker mode, we simply set the iframe src.
                // (reading the backend is handled by the ServiceWorker itself)

                // We will need the encoded URL on article load so that we can set the iframe's src correctly,
                // but we must not encode the '/' character or else relative links may fail [kiwix-js #498]
                var encodedUrl = dirEntry.url.replace(/[^/]+/g, function (matchedSubstring) {
                    return encodeURIComponent(matchedSubstring);
                });
                var iframeArticleContent = document.getElementById('articleContent');
                iframeArticleContent.onload = function () {
                    // The content is fully loaded by the browser : we can hide the spinner
                    $("#cachingAssets").html("Caching assets...");
                    $("#cachingAssets").hide();
                    $("#searchingArticles").hide();
                    // Set the requested appTheme
                    uiUtil.applyAppTheme(params.appTheme);
                    // Display the iframe content
                    $("#articleContent").show();
                    // Deflect drag-and-drop of ZIM file on the iframe to Config
                    var doc = iframeArticleContent.contentDocument ? iframeArticleContent.contentDocument.documentElement : null;
                    var docBody = doc ? doc.getElementsByTagName('body') : null;
                    docBody = docBody ? docBody[0] : null;
                    if (docBody) {
                        docBody.addEventListener('dragover', kiwixUtil.handleIframeDragover);
                        docBody.addEventListener('drop', kiwixUtil.handleIframeDrop);
                    }
                    kiwixUtil.resizeIFrame();
                    // Reset UI when the article is unloaded
                    if (iframeArticleContent.contentWindow) iframeArticleContent.contentWindow.onunload = function () {
                        $("#articleList").empty();
                        $('#articleListHeaderMessage').empty();
                        $('#articleListWithHeader').hide();
                        $("#prefix").val("");
                        $("#searchingArticles").show();
                    };
                };

                if (!kiwixUtil.isDirEntryExpectedToBeDisplayed(dirEntry)) {
                    return;
                }

                // We put the ZIM filename as a prefix in the URL, so that browser caches are separate for each ZIM file
                iframeArticleContent.src = "../" + selectedArchive._file._files[0].name + "/" + dirEntry.namespace + "/" + encodedUrl;
            } else {
                // In jQuery mode, we read the article content in the backend and manually insert it in the iframe
                if (dirEntry.isRedirect()) {
                    selectedArchive.resolveRedirect(dirEntry, readArticle);
                } else {
                    // Line below was inserted to prevent the spinner being hidden, possibly by an async function, when pressing the Random button in quick succession
                    // TODO: Investigate whether it is really an async issue or whether there is a rogue .hide() statement in the chain
                    $("#searchingArticles").show();
                    selectedArchive.readUtf8File(dirEntry, kiwixUtil.displayArticleContentInIframe);
                }
            }
        };


        /**
 * Extracts the content of the given article title, or a downloadable file, from the ZIM
 * 
 * @param {String} title The path and filename to the article or file to be extracted
 * @param {Boolean|String} download A Bolean value that will trigger download of title, or the filename that should
 *     be used to save the file in local FS (in HTML5 spec, a string value for the download attribute is optional)
 * @param {String} contentType The mimetype of the downloadable file, if known 
 */
        kiwixUtil.goToArticle = function (title, download, contentType) {
            $("#searchingArticles").show();
            selectedArchive.getDirEntryByTitle(title).then(function (dirEntry) {
                if (dirEntry === null || dirEntry === undefined) {
                    $("#searchingArticles").hide();
                    alert("Article with title " + title + " not found in the archive");
                } else if (download) {
                    selectedArchive.readBinaryFile(dirEntry, function (fileDirEntry, content) {
                        var mimetype = contentType || fileDirEntry.getMimetype();
                        uiUtil.displayFileDownloadAlert(title, download, mimetype, content);
                    });
                } else {
                    params.isLandingPage = false;
                    $('ctiveContent').hide();
                    kiwixUtil.readArticle(dirEntry);
                }
            }).catch(function (e) { alert("Error reading article with title " + title + " : " + e); });
        };


        return {
            setLocalArchiveFromFileSelect: kiwixUtil.setLocalArchiveFromFileSelect,
            isDirEntryExpectedToBeDisplayed: kiwixUtil.isDirEntryExpectedToBeDisplayed,
            resizeIFrame: kiwixUtil.resizeIFrame,
            setContentInjectionMode: kiwixUtil.setContentInjectionMode,
            refreshAPIStatus: kiwixUtil.refreshAPIStatus,
            isServiceWorkerAvailable: kiwixUtil.isServiceWorkerAvailable,
            isMessageChannelAvailable: kiwixUtil.isMessageChannelAvailable,
            isServiceWorkerReady: kiwixUtil.isServiceWorkerReady,
            refreshCacheStatus: kiwixUtil.refreshCacheStatus,
            getCacheAttributes: kiwixUtil.getCacheAttributes,
            setLocalArchiveFromArchiveList: kiwixUtil.setLocalArchiveFromArchiveList,
            resetCssCache: kiwixUtil.resetCssCache,
            setLocalArchiveFromFileList: kiwixUtil.setLocalArchiveFromFileList,
            getSelectedArchive: kiwixUtil.getSelectedArchive,
            initOrKeepAliveServiceWorker: kiwixUtil.initOrKeepAliveServiceWorker,
            displayArticleContentInIframe: kiwixUtil.displayArticleContentInIframe,
            updateCacheStatus: kiwixUtil.updateCacheStatus,
            handleIframeDragover: kiwixUtil.handleIframeDragover,
            handleIframeDrop: kiwixUtil.handleIframeDrop,
            pushBrowserHistoryState: kiwixUtil.pushBrowserHistoryState,
            goToArticle: kiwixUtil.goToArticle,
            readArticle: kiwixUtil.readArticle
        };
    });