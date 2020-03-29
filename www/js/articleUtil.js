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

// This uses require.js to structure javascript:
// http://requirejs.org/docs/api.html#define


'use strict';
define(['kiwixUtil', 'jquery', 'cookies'],
    function (kiwixUtil, $, cookies) {

        var articleUtil = {};

        params['hideActiveContentWarning'] = cookies.getItem('hideActiveContentWarning') === 'true';
        params['showUIAnimations'] = cookies.getItem('showUIAnimations') ? cookies.getItem('showUIAnimations') === 'true' : true;
        // A global parameter that turns caching on or off and deletes the cache (it defaults to true unless explicitly turned off in UI)
        params['useCache'] = cookies.getItem('useCache') !== 'false';
        // A parameter to set the app theme and, if necessary, the CSS theme for article content (defaults to 'light')
        params['appTheme'] = cookies.getItem('appTheme') || 'light'; // Currently implemented: light|dark|dark_invert|dark_mwInvert

        articleUtil.goToRandomArticle = function () {
            $("#searchingArticles").show();
            var selectedArchive = kiwixUtil.getSelectedArchive();
            selectedArchive.getRandomDirEntry(function (dirEntry) {
                if (dirEntry === null || dirEntry === undefined) {
                    $("#searchingArticles").hide();
                    alert("Error finding random article.");
                } else {
                    if (dirEntry.namespace === 'A') {
                        params.isLandingPage = false;
                        $('#activeContent').hide();
                        $('#searchingArticles').show();
                        kiwixUtil.readArticle(dirEntry);
                    } else {
                        // If the random title search did not end up on an article,
                        // we try again, until we find one
                        articleUtil.goToRandomArticle();
                    }
                }
            });
        };

        articleUtil.goToMainArticle = function () {
            $("#searchingArticles").show();
            var selectedArchive = kiwixUtil.getSelectedArchive();
            console.log(selectedArchive);
            selectedArchive.getMainPageDirEntry(function (dirEntry) {
                if (dirEntry === null || dirEntry === undefined) {
                    console.error("Error finding main article.");
                    $("#searchingArticles").hide();
                    $("#welcomeText").show();
                } else {
                    if (dirEntry.namespace === 'A') {
                        params.isLandingPage = true;
                        kiwixUtil.readArticle(dirEntry);
                    } else {
                        console.error("The main page of this archive does not seem to be an article");
                        $("#searchingArticles").hide();
                        $("#welcomeText").show();
                    }
                }
            });
        };

        return {
            goToRandomArticle: articleUtil.goToRandomArticle,
            goToMainArticle: articleUtil.goToMainArticle
        }
    });
