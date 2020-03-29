/**
 * app.js : User Interface implementation
 * This file handles the interaction between the application and the user
 * 
 * Copyright 2013-2014 Mossroy and contributors
 * License GPL v3:
 * 
 * This file is part of Kiwix.
 * 
 * Kiwix is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * Kiwix is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with Kiwix (file LICENSE-GPLv3.txt).  If not, see <http://www.gnu.org/licenses/>
 */

'use strict';

// This uses require.js to structure javascript:
// http://requirejs.org/docs/api.html#define

define(['jquery', 'zimArchiveLoader', 'uiUtil', 'cookies','abstractFilesystemAccess','q', 'kiwixUtil', 'articleUtil'],
 function($, zimArchiveLoader, uiUtil, cookies, abstractFilesystemAccess, Q, kiwixUtil, articleUtil) {
     
    /**
     * Maximum number of articles to display in a search
     * @type Integer
     */
    var MAX_SEARCH_RESULT_SIZE = 50;

    /**
     * The name of the Cache API cache to use for caching Service Worker requests and responses for certain asset types
     * This name will be passed to service-worker.js in messaging to avoid duplication: see comment in service-worker.js
     * We need access to this constant in app.js in order to complete utility actions when Service Worker is not initialized 
     * @type {String}
     */
    var CACHE_NAME = 'kiwixjs-assetCache';

    var selectedArchive = null;
    
    // Set parameters and associated UI elements from cookie
    // DEV: The params global object is declared in init.js so that it is available to modules
    params['hideActiveContentWarning'] = cookies.getItem('hideActiveContentWarning') === 'true';
    params['showUIAnimations'] = cookies.getItem('showUIAnimations') ? cookies.getItem('showUIAnimations') === 'true' : true;
    document.getElementById('hideActiveContentWarningCheck').checked = params.hideActiveContentWarning;
    document.getElementById('showUIAnimationsCheck').checked = params.showUIAnimations;
    // A global parameter that turns caching on or off and deletes the cache (it defaults to true unless explicitly turned off in UI)
    params['useCache'] = cookies.getItem('useCache') !== 'false';
    // A parameter to set the app theme and, if necessary, the CSS theme for article content (defaults to 'light')
    params['appTheme'] = cookies.getItem('appTheme') || 'light'; // Currently implemented: light|dark|dark_invert|dark_mwInvert
    document.getElementById('appThemeSelect').value = params.appTheme;
    uiUtil.applyAppTheme(params.appTheme);

    // Define globalDropZone (universal drop area) and configDropZone (highlighting area on Config page)
    var globalDropZone = document.getElementById('search-article');
    var configDropZone = document.getElementById('configuration');
    
    $(document).ready(kiwixUtil.resizeIFrame);
    $(window).resize(kiwixUtil.resizeIFrame);
    
    // Define behavior of HTML elements
    var searchArticlesFocused = false;
    $('#searchArticles').on('click', function() {
        $("#welcomeText").hide();
        $('.alert').hide();
        $("#searchingArticles").show();
        kiwixUtil.pushBrowserHistoryState(null, $('#prefix').val());
        searchDirEntriesFromPrefix($('#prefix').val());
        $('.navbar-collapse').collapse('hide');
        document.getElementById('prefix').focus();
        // This flag is set to true in the mousedown event below
        searchArticlesFocused = false;
    });
    $('#searchArticles').on('mousedown', function() {
        // We set the flag so that the blur event of #prefix can know that the searchArticles button has been clicked
        searchArticlesFocused = true;
    });
    $('#formArticleSearch').on('submit', function() {
        document.getElementById('searchArticles').click();
        return false;
    });
    // Handle keyboard events in the prefix (article search) field
    var keyPressHandled = false;
    $('#prefix').on('keydown', function(e) {
        // If user presses Escape...
        // IE11 returns "Esc" and the other browsers "Escape"; regex below matches both
        if (/^Esc/.test(e.key)) {
            // Hide the article list
            e.preventDefault();
            e.stopPropagation();
            $('#articleListWithHeader').hide();
            $('#articleContent').focus();
            keyPressHandled = true;
        }
        // Arrow-key selection code adapted from https://stackoverflow.com/a/14747926/9727685
        // IE11 produces "Down" instead of "ArrowDown" and "Up" instead of "ArrowUp"
        if (/^((Arrow)?Down|(Arrow)?Up|Enter)$/.test(e.key)) {
            // User pressed Down arrow or Up arrow or Enter
            e.preventDefault();
            e.stopPropagation();
            // This is needed to prevent processing in the keyup event : https://stackoverflow.com/questions/9951274
            keyPressHandled = true;
            var activeElement = document.querySelector("#articleList .hover") || document.querySelector("#articleList a");
            if (!activeElement) return;
            // If user presses Enter, read the dirEntry
            if (/Enter/.test(e.key)) {
                if (activeElement.classList.contains('hover')) {
                    var dirEntryId = activeElement.getAttribute('dirEntryId');
                    findDirEntryFromDirEntryIdAndLaunchArticleRead(dirEntryId);
                    return;
                }
            }
            // If user presses ArrowDown...
            // (NB selection is limited to five possibilities by regex above)
            if (/Down/.test(e.key)) {
                if (activeElement.classList.contains('hover')) {
                    activeElement.classList.remove('hover');
                    activeElement = activeElement.nextElementSibling || activeElement;
                    var nextElement = activeElement.nextElementSibling || activeElement;
                    if (!uiUtil.isElementInView(nextElement, true)) nextElement.scrollIntoView(false);
                }
            }
            // If user presses ArrowUp...
            if (/Up/.test(e.key)) {
                activeElement.classList.remove('hover');
                activeElement = activeElement.previousElementSibling || activeElement;
                var previousElement = activeElement.previousElementSibling || activeElement;
                if (!uiUtil.isElementInView(previousElement, true)) previousElement.scrollIntoView();
                if (previousElement === activeElement) document.getElementById('top').scrollIntoView();
            }
            activeElement.classList.add('hover');
        }
    });
    // Search for titles as user types characters
    $('#prefix').on('keyup', function(e) {
        if (selectedArchive !== null && selectedArchive.isReady()) {
            // Prevent processing by keyup event if we already handled the keypress in keydown event
            if (keyPressHandled)
                keyPressHandled = false;
            else
                onKeyUpPrefix(e);
        }
    });
    // Restore the search results if user goes back into prefix field
    $('#prefix').on('focus', function(e) {
        if ($('#prefix').val() !== '') 
            $('#articleListWithHeader').show();
    });
    // Hide the search results if user moves out of prefix field
    $('#prefix').on('blur', function() {
        if (!searchArticlesFocused) $('#articleListWithHeader').hide();
    });
    $("#btnRandomArticle").on("click", function(e) {
        $('#prefix').val("");
        articleUtil.goToRandomArticle();
        $("#welcomeText").hide();
        $('#articleListWithHeader').hide();
        $('.navbar-collapse').collapse('hide');
    });
    
    $('#btnRescanDeviceStorage').on("click", function(e) {
        searchForArchivesInStorage();
    });
    // Bottom bar :
    $('#btnBack').on('click', function(e) {
        history.back();
        return false;
    });
    $('#btnForward').on('click', function(e) {
        history.forward();
        return false;
    });
    $('#btnHomeBottom').on('click', function(e) {
        $('#btnHome').click();
        return false;
    });
    $('#btnTop').on('click', function(e) {
        $("#articleContent").contents().scrollTop(0);
        // We return true, so that the link to #top is still triggered (useful in the About section)
        return true;
    });
    // Top menu :
    $('#btnHome').on('click', function(e) {
        // Highlight the selected section in the navbar
        $('#liHomeNav').attr("class","active");
        $('#liConfigureNav').attr("class","");
        $('#liAboutNav').attr("class","");
        $('.navbar-collapse').collapse('hide');
        // Show the selected content in the page
        uiUtil.removeAnimationClasses();
        if (params.showUIAnimations) { 
           uiUtil.applyAnimationToSection("home");
        } else {
            $('#articleContent').show();
            $('#about').hide();
            $('#configuration').hide();
        }
        $('#navigationButtons').show();
        $('#formArticleSearch').show();
        $("#welcomeText").show();
        // Give the focus to the search field, and clean up the page contents
        $("#prefix").val("");
        $('#prefix').focus();
        $("#articleList").empty();
        $('#articleListHeaderMessage').empty();
        $("#searchingArticles").hide();
        $("#articleContent").hide();
        $("#articleContent").contents().empty();
        selectedArchive = kiwixUtil.getSelectedArchive();
        if (selectedArchive !== null && selectedArchive.isReady()) {
            $("#welcomeText").hide();
            articleUtil.goToMainArticle();
        }
        // Use a timeout of 400ms because uiUtil.applyAnimationToSection uses a timeout of 300ms
        setTimeout(kiwixUtil.resizeIFrame, 400);
        return false;
    });
    $('#btnConfigure').on('click', function(e) {
        // Highlight the selected section in the navbar
        $('#liHomeNav').attr("class","");
        $('#liConfigureNav').attr("class","active");
        $('#liAboutNav').attr("class","");
        $('.navbar-collapse').collapse('hide');
        // Show the selected content in the page
        uiUtil.removeAnimationClasses();
        if (params.showUIAnimations) { 
            uiUtil.applyAnimationToSection("config");
        } else {
            $('#about').hide();
            $('#configuration').show();
            $('#articleContent').hide();
        }    
        $('#navigationButtons').hide();
        $('#formArticleSearch').hide();
        $("#welcomeText").hide();
        $("#searchingArticles").hide();
        $('.alert').hide();
        kiwixUtil.refreshAPIStatus();
        kiwixUtil.refreshCacheStatus();
        // Use a timeout of 400ms because uiUtil.applyAnimationToSection uses a timeout of 300ms
        setTimeout(kiwixUtil.resizeIFrame, 400);
        return false;
    });
    $('#btnAbout').on('click', function(e) {
        // Highlight the selected section in the navbar
        $('#liHomeNav').attr("class","");
        $('#liConfigureNav').attr("class","");
        $('#liAboutNav').attr("class","active");
        $('.navbar-collapse').collapse('hide');
        // Show the selected content in the page
        uiUtil.removeAnimationClasses();
        if (params.showUIAnimations) { 
            uiUtil.applyAnimationToSection("about");
        } else {
            $('#about').show();
            $('#configuration').hide();
            $('#articleContent').hide();
        }
        $('#navigationButtons').hide();
        $('#formArticleSearch').hide();
        $("#welcomeText").hide();
        $('#articleListWithHeader').hide();
        $("#searchingArticles").hide();
        $('.alert').hide();
        // Use a timeout of 400ms because uiUtil.applyAnimationToSection uses a timeout of 300ms
        setTimeout(kiwixUtil.resizeIFrame, 400);
        return false;
    });
    $('input:radio[name=contentInjectionMode]').on('change', function(e) {
        // Do the necessary to enable or disable the Service Worker
        kiwixUtil.setContentInjectionMode(this.value);
    });
    $('input:checkbox[name=hideActiveContentWarning]').on('change', function (e) {
        params.hideActiveContentWarning = this.checked ? true : false;
        cookies.setItem('hideActiveContentWarning', params.hideActiveContentWarning, Infinity);
    });
    $('input:checkbox[name=showUIAnimations]').on('change', function (e) {
        params.showUIAnimations = this.checked ? true : false;
        cookies.setItem('showUIAnimations', params.showUIAnimations, Infinity);
    });
    document.getElementById('appThemeSelect').addEventListener('change', function (e) {
        params.appTheme = e.target.value;
        cookies.setItem('appTheme', params.appTheme, Infinity);
        uiUtil.applyAppTheme(params.appTheme);
    });
    document.getElementById('cachedAssetsModeRadioTrue').addEventListener('change', function (e) {
        if (e.target.checked) {
            cookies.setItem('useCache', true, Infinity);
            params.useCache = true;
            kiwixUtil.refreshCacheStatus();
        }
    });
    document.getElementById('cachedAssetsModeRadioFalse').addEventListener('change', function (e) {
        if (e.target.checked) {
            cookies.setItem('useCache', false, Infinity);
            params.useCache = false;
            // Delete all caches
            kiwixUtil.resetCssCache();
            if ('caches' in window) caches.delete(CACHE_NAME);
            kiwixUtil.refreshCacheStatus();
        }
    });
            
    // At launch, we try to set the last content injection mode (stored in a cookie)
    var lastContentInjectionMode = cookies.getItem('lastContentInjectionMode');
    if (lastContentInjectionMode) {
        kiwixUtil.setContentInjectionMode(lastContentInjectionMode);
    }
    else {
        kiwixUtil.setContentInjectionMode('jquery');
    }
    
    // We need to establish the caching capabilities before first page launch
    kiwixUtil.refreshCacheStatus();
    
    /**
     * 
     * @type Array.<StorageFirefoxOS>
     */
    var storages = [];
    function searchForArchivesInPreferencesOrStorage() {
        // First see if the list of archives is stored in the cookie
        var listOfArchivesFromCookie = cookies.getItem("listOfArchives");
        if (listOfArchivesFromCookie !== null && listOfArchivesFromCookie !== undefined && listOfArchivesFromCookie !== "") {
            var directories = listOfArchivesFromCookie.split('|');
            populateDropDownListOfArchives(directories);
        }
        else {
            searchForArchivesInStorage();
        }
    }
    function searchForArchivesInStorage() {
        // If DeviceStorage is available, we look for archives in it
        $("#btnConfigure").click();
        $('#scanningForArchives').show();
        zimArchiveLoader.scanForArchives(storages, populateDropDownListOfArchives);
    }

    if ($.isFunction(navigator.getDeviceStorages)) {
        // The method getDeviceStorages is available (FxOS>=1.1)
        storages = $.map(navigator.getDeviceStorages("sdcard"), function(s) {
            return new abstractFilesystemAccess.StorageFirefoxOS(s);
        });
    }

    if (storages !== null && storages.length > 0) {
        // Make a fake first access to device storage, in order to ask the user for confirmation if necessary.
        // This way, it is only done once at this moment, instead of being done several times in callbacks
        // After that, we can start looking for archives
        storages[0].get("fake-file-to-read").then(searchForArchivesInPreferencesOrStorage,
                                                  searchForArchivesInPreferencesOrStorage);
    }
    else {
        // If DeviceStorage is not available, we display the file select components
        displayFileSelect();
        if (document.getElementById('archiveFiles').files && document.getElementById('archiveFiles').files.length>0) {
            // Archive files are already selected, 
            kiwixUtil.setLocalArchiveFromFileSelect();
        }
        else {
            $("#btnConfigure").click();
        }
    }


    // Display the article when the user goes back in the browser history
    window.onpopstate = function(event) {
        if (event.state) {
            var title = event.state.title;
            var titleSearch = event.state.titleSearch;
            
            $('#prefix').val("");
            $("#welcomeText").hide();
            $("#searchingArticles").hide();
            $('.navbar-collapse').collapse('hide');
            $('#configuration').hide();
            $('#articleListWithHeader').hide();
            $('#articleContent').contents().empty();
            
            if (title && !(""===title)) {
                kiwixUtil.goToArticle(title);
            }
            else if (titleSearch && !(""===titleSearch)) {
                $('#prefix').val(titleSearch);
                searchDirEntriesFromPrefix($('#prefix').val());
            }
        }
    };
    
    /**
     * Populate the drop-down list of archives with the given list
     * @param {Array.<String>} archiveDirectories
     */
    function populateDropDownListOfArchives(archiveDirectories) {
        $('#scanningForArchives').hide();
        $('#chooseArchiveFromLocalStorage').show();
        var comboArchiveList = document.getElementById('archiveList');
        comboArchiveList.options.length = 0;
        for (var i = 0; i < archiveDirectories.length; i++) {
            var archiveDirectory = archiveDirectories[i];
            if (archiveDirectory === "/") {
                alert("It looks like you have put some archive files at the root of your sdcard (or internal storage). Please move them in a subdirectory");
            }
            else {
                comboArchiveList.options[i] = new Option(archiveDirectory, archiveDirectory);
            }
        }
        // Store the list of archives in a cookie, to avoid rescanning at each start
        cookies.setItem("listOfArchives", archiveDirectories.join('|'), Infinity);
        
        $('#archiveList').on('change', kiwixUtil.setLocalArchiveFromArchiveList);
        if (comboArchiveList.options.length > 0) {
            var lastSelectedArchive = cookies.getItem("lastSelectedArchive");
            if (lastSelectedArchive !== null && lastSelectedArchive !== undefined && lastSelectedArchive !== "") {
                // Attempt to select the corresponding item in the list, if it exists
                if ($("#archiveList option[value='"+lastSelectedArchive+"']").length > 0) {
                    $("#archiveList").val(lastSelectedArchive);
                }
            }
            // Set the localArchive as the last selected (or the first one if it has never been selected)
            kiwixUtil.setLocalArchiveFromArchiveList();
        }
        else {
            alert("Welcome to Kiwix! This application needs at least a ZIM file in your SD-card (or internal storage). Please download one and put it on the device (see About section). Also check that your device is not connected to a computer through USB device storage (which often locks the SD-card content)");
            $("#btnAbout").click();
            var isAndroid = (navigator.userAgent.indexOf("Android") !== -1);
            if (isAndroid) {
                alert("You seem to be using an Android device. Be aware that there is a bug on Firefox, that prevents finding Wikipedia archives in a SD-card (at least on some devices. See about section). Please put the archive in the internal storage if the application can't find it.");
            }
        }
    }

    /**
     * Displays the zone to select files from the archive
     */
    function displayFileSelect() {
        document.getElementById('openLocalFiles').style.display = 'block';
        // Set the main drop zone
        configDropZone.addEventListener('dragover', handleGlobalDragover);
        configDropZone.addEventListener('dragleave', function(e) {
            configDropZone.style.border = '';
        });
        // Also set a global drop zone (allows us to ensure Config is always displayed for the file drop)
        globalDropZone.addEventListener('dragover', function(e) {
            e.preventDefault();
            if (configDropZone.style.display === 'none') document.getElementById('btnConfigure').click();
            e.dataTransfer.dropEffect = 'link';
        });
        globalDropZone.addEventListener('drop', handleFileDrop);
        // This handles use of the file picker
        document.getElementById('archiveFiles').addEventListener('change', kiwixUtil.setLocalArchiveFromFileSelect);
    }

    function handleGlobalDragover(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        configDropZone.style.border = '3px dotted red';
    }

    function handleFileDrop(packet) {
        packet.stopPropagation();
        packet.preventDefault();
        configDropZone.style.border = '';
        var files = packet.dataTransfer.files;
        document.getElementById('openLocalFiles').style.display = 'none';
        document.getElementById('downloadInstruction').style.display = 'none';
        document.getElementById('selectorsDisplay').style.display = 'inline';
        kiwixUtil.setLocalArchiveFromFileList(files);
        // This clears the display of any previously picked archive in the file selector
        document.getElementById('archiveFiles').value = null;
    }

    // Add event listener to link which allows user to show file selectors
    document.getElementById('selectorsDisplayLink').addEventListener('click', function(e) {
        e.preventDefault();
        document.getElementById('openLocalFiles').style.display = 'block';
        document.getElementById('selectorsDisplay').style.display = 'none';
    });

    /**
     * Reads a remote archive with given URL, and returns the response in a Promise.
     * This function is used by setRemoteArchives below, for UI tests
     * 
     * @param {String} url The URL of the archive to read
     * @returns {Promise<Blob>} A promise for the requested file (blob)
     */
    function readRemoteArchive(url) {
        // DEV: This deferred can't be standardized to a Promise/A+ pattern (using Q) because
        // IE11 is unable to scope the callbacks inside the Promise correctly. See [kiwix.js #589]
        var deferred = Q.defer();
        var request = new XMLHttpRequest();
        request.open("GET", url);
        request.responseType = "blob";
        request.onreadystatechange = function () {
            if (request.readyState === XMLHttpRequest.DONE) {
                if (request.status >= 200 && request.status < 300 || request.status === 0) {
                    // Hack to make this look similar to a file
                    request.response.name = url;
                    deferred.resolve(request.response);
                } else {
                    deferred.reject("HTTP status " + request.status + " when reading " + url);
                }
            }
        };
        request.onabort = request.onerror = deferred.reject;
        request.send();
        return deferred.promise;
    }
    
    /**
     * This is used in the testing interface to inject remote archives
     * @returns {Promise<Array>} A Promise for an array of archives  
     */
    window.setRemoteArchives = function () {
        var readRequests = [];
        Array.prototype.slice.call(arguments).forEach(function (arg) {
            readRequests.push(readRemoteArchive(arg));
        });
        return Q.all(readRequests).then(function (arrayOfArchives) {
            kiwixUtil.setLocalArchiveFromFileList(arrayOfArchives);
        }).catch(function (e) {
            console.error('Unable to load remote archive(s)', e);
        });
    };

    /**
     * Handle key input in the prefix input zone
     * @param {Event} evt
     */
    function onKeyUpPrefix(evt) {
        // Use a timeout, so that very quick typing does not cause a lot of overhead
        // It is also necessary for the words suggestions to work inside Firefox OS
        if(window.timeoutKeyUpPrefix) {
            window.clearTimeout(window.timeoutKeyUpPrefix);
        }
        window.timeoutKeyUpPrefix = window.setTimeout(function() {
            var prefix = $("#prefix").val();
            if (prefix && prefix.length>0) {
                $('#searchArticles').click();
            }
        }
        ,500);
    }

    /**
     * Search the index for DirEntries with title that start with the given prefix (implemented
     * with a binary search inside the index file)
     * @param {String} prefix
     */
    function searchDirEntriesFromPrefix(prefix) {
        if (selectedArchive !== null && selectedArchive.isReady()) {
            $('#activeContent').hide();
            selectedArchive.findDirEntriesWithPrefix(prefix.trim(), MAX_SEARCH_RESULT_SIZE, populateListOfArticles);
        } else {
            $('#searchingArticles').hide();
            // We have to remove the focus from the search field,
            // so that the keyboard does not stay above the message
            $("#searchArticles").focus();
            alert("Archive not set : please select an archive");
            $("#btnConfigure").click();
        }
    }

    /**
     * Display the list of articles with the given array of DirEntry
     * @param {Array} dirEntryArray The array of dirEntries returned from the binary search
     */
    function populateListOfArticles(dirEntryArray) {
        var articleListHeaderMessageDiv = $('#articleListHeaderMessage');
        var nbDirEntry = dirEntryArray ? dirEntryArray.length : 0;

        var message;
        if (nbDirEntry >= MAX_SEARCH_RESULT_SIZE) {
            message = 'First ' + MAX_SEARCH_RESULT_SIZE + ' articles below (refine your search).';
        } else {
            message = nbDirEntry + ' articles found.';
        }
        if (nbDirEntry === 0) {
            message = 'No articles found.';
        }

        articleListHeaderMessageDiv.html(message);

        var articleListDiv = $('#articleList');
        var articleListDivHtml = '';
        var listLength = dirEntryArray.length < MAX_SEARCH_RESULT_SIZE ? dirEntryArray.length : MAX_SEARCH_RESULT_SIZE;
        for (var i = 0; i < listLength; i++) {
            var dirEntry = dirEntryArray[i];
            var dirEntryStringId = uiUtil.htmlEscapeChars(dirEntry.toStringId());
            articleListDivHtml += '<a href="#" dirEntryId="' + dirEntryStringId +
                '" class="list-group-item">' + dirEntry.getTitleOrUrl() + '</a>';
        }
        articleListDiv.html(articleListDivHtml);
        // We have to use mousedown below instead of click as otherwise the prefix blur event fires first 
        // and prevents this event from firing; note that touch also triggers mousedown
        $('#articleList a').on('mousedown', function (e) {
            handleTitleClick(e);
            return false;
        });
        $('#searchingArticles').hide();
        $('#articleListWithHeader').show();
    }
    
    /**
     * Handles the click on the title of an article in search results
     * @param {Event} event
     * @returns {Boolean}
     */
    function handleTitleClick(event) {       
        var dirEntryId = event.target.getAttribute("dirEntryId");
        findDirEntryFromDirEntryIdAndLaunchArticleRead(dirEntryId);
        return false;
    }

    /**
     * Creates an instance of DirEntry from given dirEntryId (including resolving redirects),
     * and call the function to read the corresponding article
     * @param {String} dirEntryId
     */
    function findDirEntryFromDirEntryIdAndLaunchArticleRead(dirEntryId) {
        if (selectedArchive.isReady()) {
            var dirEntry = selectedArchive.parseDirEntryId(dirEntryId);
            // Remove focus from search field to hide keyboard and to allow navigation keys to be used
            document.getElementById('articleContent').contentWindow.focus();
            $("#searchingArticles").show();
            if (dirEntry.isRedirect()) {
                selectedArchive.resolveRedirect(dirEntry, kiwixUtil.readArticle);
            } else {
                params.isLandingPage = false;
                kiwixUtil.readArticle(dirEntry);
            }
        } else {
            alert("Data files not set");
        }
    }
});
