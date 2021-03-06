/** @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('GoogleSmartCard.ConnectorApp.BackgroundMain');

goog.require('GoogleSmartCard.Libusb.ChromeUsbBackend');
goog.require('GoogleSmartCard.Logging');
goog.require('GoogleSmartCard.MessagingCommon');
goog.require('GoogleSmartCard.MessageChannelPair');
goog.require('GoogleSmartCard.MessageChannelPool');
goog.require('GoogleSmartCard.NaclModule');
goog.require('GoogleSmartCard.PopupWindow.Server');
goog.require('GoogleSmartCard.PortMessageChannel');
goog.require('GoogleSmartCard.PcscLiteServer.ReaderTracker');
goog.require('GoogleSmartCard.PcscLiteServerClientsManagement.ClientHandler');
goog.require('GoogleSmartCard.PcscLiteServerClientsManagement.ReadinessTracker');
goog.require('GoogleSmartCard.SingleMessageBasedChannel');

goog.scope(function() {

/** @const */
var WINDOW_URL = 'window.html';

/**
 * Note: the bounds of the window were carefully adjusted in order to fit the
 * USB device selector dialog (as shown by the chrome.usb.getUserSelectedDevices
 * method: refer to
 * <https://developer.chrome.com/apps/usb#method-getUserSelectedDevices>).
 * @const
 */
var WINDOW_OPTIONS = {
  'frame': 'none',
  'hidden': true,
  'id': 'window',
  'innerBounds': {
    'width': 530,
    'height': 430
  },
  'resizable': false
};

/** @const */
var GSC = GoogleSmartCard;

/**
 * @type {!goog.log.Logger}
 * @const
 */
var logger = GSC.Logging.getScopedLogger('ConnectorApp.BackgroundMain');

logger.info(
    'The Smart Card Connector app (id "' + chrome.runtime.id + '", version ' +
    chrome.runtime.getManifest()['version'] + ') background script started');
logger.info('Browser version: "' + window.navigator.appVersion + '"');

var naclModule = new GSC.NaclModule(
    'nacl_module.nmf', GSC.NaclModule.Type.PNACL);
naclModule.addOnDisposeCallback(naclModuleDisposedListener);

var libusbChromeUsbBackend = new GSC.Libusb.ChromeUsbBackend(
    naclModule.messageChannel);
var pcscLiteReadinessTracker =
    new GSC.PcscLiteServerClientsManagement.ReadinessTracker(
        naclModule.messageChannel);
var messageChannelPool = new GSC.MessageChannelPool();

var readerTrackerMessageChannelPair = new GSC.MessageChannelPair;
createClientHandler(readerTrackerMessageChannelPair.getFirst(), undefined);
var readerTracker = new GSC.PcscLiteServer.ReaderTracker(
    naclModule.messageChannel,
    readerTrackerMessageChannelPair.getSecond(),
    naclModule.logger);

naclModule.startLoading();

chrome.app.runtime.onLaunched.addListener(launchedListener);

chrome.runtime.onConnect.addListener(connectionListener);
chrome.runtime.onConnectExternal.addListener(externalConnectionListener);
chrome.runtime.onMessageExternal.addListener(externalMessageListener);

chrome.runtime.onInstalled.addListener(installedListener);

function naclModuleDisposedListener() {
  if (!goog.DEBUG) {
    // Trigger the fatal error in the Release mode, that will emit an error
    // message and trigger the app reload.
    GSC.Logging.failWithLogger(logger, 'Server NaCl module was disposed of');
  }
}

function launchedListener() {
  logger.fine('Received onLaunched event, opening window...');
  openWindow();
}

function openWindow() {
  var data = {
      'clientAppListUpdateSubscriber':
          messageChannelPool.addOnUpdateListener.bind(messageChannelPool),
      'readerTrackerSubscriber':
          readerTracker.addOnUpdateListener.bind(readerTracker),
      'readerTrackerUnsubscriber':
          readerTracker.removeOnUpdateListener.bind(readerTracker)};
  GSC.PopupWindow.Server.createWindow(WINDOW_URL, WINDOW_OPTIONS, data);
}

/**
 * @param {!Port} port
 */
function connectionListener(port) {
  logger.fine('Received onConnect event');
  var portMessageChannel = new GSC.PortMessageChannel(port);
  createClientHandler(portMessageChannel, undefined);
}

/**
 * @param {!Port} port
 */
function externalConnectionListener(port) {
  logger.fine('Received onConnectExternal event');
  var portMessageChannel = new GSC.PortMessageChannel(port);
  if (goog.isNull(portMessageChannel.extensionId)) {
    logger.warning('Ignoring the external connection as there is no sender ' +
                   'extension id specified');
    return;
  }
  messageChannelPool.addChannel(
      portMessageChannel.extensionId, portMessageChannel);
  GSC.MessagingCommon.setNonFatalDefaultServiceCallback(portMessageChannel);
  createClientHandler(portMessageChannel, portMessageChannel.extensionId);
}

/**
 * @param {*} message
 * @param {!MessageSender} sender
 */
function externalMessageListener(message, sender) {
  logger.fine('Received onMessageExternal event');
  if (!goog.isDef(sender.id)) {
    logger.warning('Ignoring the external message as there is no sender ' +
                   'extension id specified');
    return;
  }
  var channel = getOrCreateSingleMessageBasedChannel(sender.id);
  if (!channel)
    return;
  channel.deliverMessage(message);
  if (channel.isDisposed()) {
    // The channel could get disposed of due to the detected client reload. So
    // here an attempt is made to deliver the same message again to a freshly
    // created message channel, so that the message from the reloaded client has
    // a chance to be handled.
    channel = getOrCreateSingleMessageBasedChannel(sender.id);
    if (!channel)
      return;
    channel.deliverMessage(message);
  }
}

/**
 * @param {string} clientExtensionId
 * @return {GSC.SingleMessageBasedChannel}
 */
function getOrCreateSingleMessageBasedChannel(clientExtensionId) {
  var existingChannel = messageChannelPool.getChannels(clientExtensionId).find(
      function(channel) {
        return channel instanceof GSC.SingleMessageBasedChannel;
      });
  if (existingChannel)
    return /** @type !GSC.SingleMessageBasedChannel */ (existingChannel);
  var newChannel = new GSC.SingleMessageBasedChannel(
      clientExtensionId, undefined, true);
  messageChannelPool.addChannel(clientExtensionId, newChannel);
  GSC.MessagingCommon.setNonFatalDefaultServiceCallback(newChannel);
  createClientHandler(newChannel, clientExtensionId);
  if (newChannel.isDisposed())
    return null;
  return newChannel;
}

/**
 * @param {!goog.messaging.AbstractChannel} clientMessageChannel
 * @param {string|undefined} clientExtensionId
 */
function createClientHandler(clientMessageChannel, clientExtensionId) {
  GSC.Logging.checkWithLogger(logger, !clientMessageChannel.isDisposed());

  var clientTitleForLog = goog.isDef(clientExtensionId) ?
      'app "' + clientExtensionId + '"' : 'own app';

  if (naclModule.isDisposed() || naclModule.messageChannel.isDisposed()) {
    logger.warning(
        'Could not create PC/SC-Lite client handler for ' + clientTitleForLog +
        ' as the server is disposed. Disposing of the client message ' +
        'channel...');
    clientMessageChannel.dispose();
    return;
  }

  // Note: the reference to the created client handler is not stored anywhere,
  // because it manages its lifetime itself, based on the lifetimes of the
  // passed message channels.
  var clientHandler = new GSC.PcscLiteServerClientsManagement.ClientHandler(
      naclModule.messageChannel,
      pcscLiteReadinessTracker,
      clientMessageChannel,
      clientExtensionId);

  var logMessage =
      'Created a new PC/SC-Lite client handler for ' + clientTitleForLog +
      ' (handler id ' + clientHandler.id + ')';
  if (goog.isDef(clientExtensionId))
    logger.info(logMessage);
  else
    logger.fine(logMessage);
}

/**
 * @param {!Object} details
 */
function installedListener(details) {
  GSC.Logging.checkWithLogger(
      logger, goog.object.containsKey(details, 'reason'));
  var reason = details['reason'];
  GSC.Logging.checkWithLogger(logger, goog.isString(reason));
  if (reason == 'install') {
    logger.fine('Received onInstalled event due to the App installation, ' +
                'opening window...');
    openWindow();
  }
}

});  // goog.scope
