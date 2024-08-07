/**
* We will notify you through our webhooks, whenerver any trnsaction got
* initiated (or) modified (capture. cancel, refund, etc.,).
* Notifications should be used to keep your Shopsystem backoffice
* upto date with the status of each payment and modifications. Notifications
* are sent using HTTP POST to your server (based on your choice).
*
* @module  controllers/NovalnetWebhook
*/

'use strict';

var server = require('server');
var Transaction = require('dw/system/Transaction');
var novalnetHelper = require('*/cartridge/scripts/novalnetHelper');
var novalnetConfig = require('*/cartridge/scripts/novalnetConfig');
var OrderMgr = require('dw/order/OrderMgr');
var Resource = require('dw/web/Resource');
var crypto = require('dw/crypto');
var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');

/**
 * Handles the webhook events
 */
server.post('Notify', function (req, res, next) {
    var data = request.httpParameterMap.requestBodyAsString;

    var message = authenticateEventData(data, res, next);
    if (message) {
        return displayMessage(res, next, message);
    }

    var eventData = novalnetHelper.getFormattedResult(data);

    // Set Event data.
    var eventType = eventData.event.type;

    message = validateChecksum(eventData);
    if (message) {
        return displayMessage(res, next, message);
    }

    eventData.event.parent_tid = eventData.event.parent_tid ? eventData.event.parent_tid : eventData.event.tid;
    var orderNo = eventData.transaction.order_no ? eventData.transaction.order_no : '';
    var orderToken = (eventData.custom) ? eventData.custom.inputval1 : undefined;
    if(!orderNo) {
		return displayMessage(res, next, 'Order no missing');
	}
	
    var order = OrderMgr.getOrder(orderNo, orderToken);
    if (!order) {
        return displayMessage(res, next, 'Order not found');
    }
    if (eventType === 'PAYMENT') {
        if (!order.custom.novalnetTid) {
            message = handleCommunicationFailure(order, eventData);
            return displayMessage(res, next, (message || 'Novalnet callback script executed successfully'));
        }
        
        if(order.custom.novalnetZeroAmountBooking == true && eventData.transaction.amount != 0 && (!order.custom.novalnetPaidAmount || order.custom.novalnetPaidAmount == 0)) {
			var paymentInstrument = novalnetHelper.getPaymentInstrument(order);
			var formattedAmount = novalnetHelper.getFormattedAmount(eventData.transaction.amount, eventData.transaction.currency);
			if (eventData.result.status === 'SUCCESS') {
				var tid = eventData.transaction.tid;
				var comment = '\n' + Resource.msgf('novalnet.amount_booked', 'novalnet', null, formattedAmount, tid);
				Transaction.begin();
				Transaction.wrap(function () {
					order.custom.novalnetPaidAmount = eventData.transaction.amount;
					order.custom.novalnetOrderAmount = eventData.transaction.amount;
					order.custom.novalnetTid = tid;
					paymentInstrument.paymentTransaction.transactionID = tid;
				});
				Transaction.commit();
				novalnetHelper.addOrderNote(order, comment, true);
				sendWebHookMail(res, next, eventData.transaction.order_no, comment);
				return displayMessage(res, next, comment);
			}
		}
        return displayMessage(res, next, 'Novalnet Callback executed. The Transaction ID already existed');
    }

    if (order.custom.novalnetTid != eventData.event.parent_tid) {
        return displayMessage(res, next, 'Order reference not matching');
    }

    if (eventData.result.status && eventData.result.status === 'SUCCESS') {
        switch (eventType) {
            case 'TRANSACTION_CAPTURE':
            case 'TRANSACTION_CANCEL':
                handleTransactionCaptureCancel(order, eventData, res, next);
                break;
            case 'TRANSACTION_REFUND':
                handleTransactionRefund(order, eventData, res, next);
                break;
            case 'TRANSACTION_UPDATE':
                handleTransactionUpdate(order, eventData, res, next);
                break;
            case 'CREDIT':
                handleCredit(order, eventData, res, next);
                break;
            case 'CHARGEBACK':
                handleChargeback(order, eventData, res, next);
                break;
            case 'INSTALMENT':
                handleInstalment(order, eventData, res, next);
                break;
            case 'INSTALMENT_CANCEL':
                handleInstalmentCancel(order, eventData, res, next);
                break;
            case 'PAYMENT_REMINDER_1':
            case 'PAYMENT_REMINDER_2':
                handlePaymentReminder(order, eventData, res, next);
                break;
            case 'SUBMISSION_TO_COLLECTION_AGENCY':
                handleCollection(order, eventData, res, next);
                break;
            default:
                displayMessage(res, next, 'The webhook notification has been received for the unhandled EVENT type ' + eventType);
        }
    }
});

/**
 * Handle instalment payment event
 * @param {dw.order.Order} order - the order to handle payments.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handleInstalment(order, eventData, res, next) {
    if (eventData.transaction.status === 'CONFIRMED' && eventData.instalment.cycles_executed) {
        var eventTid = eventData.event.tid;
        var instalmentAmount = eventData.instalment && eventData.instalment.cycle_amount ? eventData.instalment.cycle_amount : eventData.transaction.amount;
        var formattedAmount = novalnetHelper.getFormattedAmount(instalmentAmount, eventData.transaction.currency);
        var comment = Resource.msgf('novalnet.webhook.instalment.recived', 'novalnet', null, eventData.event.parent_tid.toString(), formattedAmount, novalnetHelper.getCurrentDate(), eventTid.toString());
        if (order.custom.novalnetServerResponse) {
            var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
            if (paymentResponse.instalment) {
                Transaction.begin();
                Transaction.wrap(function () {
                    paymentResponse.instalment[eventData.instalment.cycles_executed] = {};
                    paymentResponse.instalment[eventData.instalment.cycles_executed].tid = eventTid.toString();
                    order.custom.novalnetServerResponse = JSON.stringify(paymentResponse);
                });
                Transaction.commit();
            }
        }
        comment += '\n' + novalnetHelper.getPaymentComments(eventData);
        updateTransactionDetails(order, comment);
        sendWebHookMail(res, next, eventData.transaction.order_no, comment);
        displayMessage(res, next, comment);
    }
}

function handleInstalmentCancel(order, eventData, res, next) {	
	if(eventData.transaction.status === 'CONFIRMED') {
		var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
		if(!empty(paymentResponse.instalment)) {
			var cancelType = eventData.instalment.cancel_type;
			var eventTid = eventData.event.tid;
			var comment;
			if (cancelType == 'ALL_CYCLES') {
				var formattedRefundAmount = novalnetHelper.getFormattedAmount(eventData.transaction.refund.amount, 'EUR');
				comment = '\n' + Resource.msgf('novalnet.cancel_all_instalment_cycle.message', 'novalnet', null, eventTid.toString(), novalnetHelper.getCurrentDate(), formattedRefundAmount);
			} else {
				comment = '\n' + Resource.msgf('novalnet.cancel_remaining_instalment_cycle.message', 'novalnet', null, eventTid.toString(), novalnetHelper.getCurrentDate());
			}
			
			var instalmentDetails = paymentResponse.instalment;
			instalmentDetails.cancel_type = 'cancel_' + cancelType.toLowerCase();
			paymentResponse.instalment = instalmentDetails;
			
			Transaction.begin();
			Transaction.wrap(function () {
				order.custom.novalnetServerResponse = JSON.stringify(paymentResponse);
				if (cancelType == 'ALL_CYCLES') {
					order.setStatus(order.ORDER_STATUS_CANCELLED);
				}
			});
			Transaction.commit();
			
			novalnetHelper.addOrderNote(order, comment, true);
			sendWebHookMail(res, next, eventData.transaction.order_no, comment);
			displayMessage(res, next, comment);
		}
	}
}

/**
 * Handle chargback event
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handleChargeback(order, eventData, res, next) {
    if (eventData.transaction.status === 'CONFIRMED' && eventData.transaction.amount) {
        var formattedAmount = novalnetHelper.getFormattedAmount(eventData.transaction.amount, eventData.transaction.currency);
        var comment = '\n' + Resource.msgf('novalnet.webhook.chargeback.executed', 'novalnet', null, eventData.event.parent_tid.toString(), formattedAmount, novalnetHelper.getCurrentDate(), eventData.event.tid.toString());
        updateTransactionDetails(order, comment);
        sendWebHookMail(res, next, eventData.transaction.order_no, comment);
        displayMessage(res, next, comment);
    }
}

/**
 * Handle credit event
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handleCredit(order, eventData, res, next) {
    var formattedAmount = novalnetHelper.getFormattedAmount(eventData.transaction.amount, eventData.transaction.currency);

    var comment = '\n' + Resource.msgf('novalnet.webhook.credit.executed', 'novalnet', null, eventData.event.parent_tid.toString(), formattedAmount, novalnetHelper.getCurrentDate(), eventData.event.tid.toString());

    if (['INVOICE_CREDIT', 'CASHPAYMENT_CREDIT', 'MULTIBANCO_CREDIT'].indexOf(eventData.transaction.payment_type) > -1) {
        var orderAmount = order.custom.novalnetOrderAmount - order.custom.novalnetRefundedAmount;
        var paidAmount = order.custom.novalnetPaidAmount;
        if (order.custom.novalnetPaidAmount < orderAmount) {
            paidAmount += eventData.transaction.amount;
            Transaction.begin();
            Transaction.wrap(function () {
                order.custom.novalnetPaidAmount = paidAmount;
                if (paidAmount >= orderAmount) {
                    order.setStatus(order.ORDER_STATUS_COMPLETED);
                    order.setPaymentStatus(order.PAYMENT_STATUS_PAID);
                    order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
                    order.setExportStatus(order.EXPORT_STATUS_READY);
                }
            });
            Transaction.commit();
        } else {
            displayMessage(res, next, 'Order already paid');
            return;
        }
    }
    updateTransactionDetails(order, comment, eventData.transaction.status);
    sendWebHookMail(res, next, eventData.transaction.order_no, comment);
    displayMessage(res, next, comment);
}

/**
 * Handle transaction update
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handleTransactionUpdate(order, eventData, res, next) {
    var status = eventData.transaction.status;
    var paymentType = eventData.transaction.payment_type;
    var formattedAmount = novalnetHelper.getFormattedAmount(eventData.transaction.amount, eventData.transaction.currency);
    
    if (['PENDING', 'ON_HOLD', 'CONFIRMED', 'DEACTIVATED'].indexOf(status) > -1) {
        var comment = '';

        if (status === 'DEACTIVATED') {
            comment = Resource.msgf('novalnet.webhook.transaction.cancelled', 'novalnet', null, novalnetHelper.getCurrentDate());
        } else if (order.custom.novalnetPaymentStatus === 'PENDING' && status === 'ON_HOLD') {
            comment = '\n' + Resource.msgf('novalnet.webhook.transaction.changed', 'novalnet', null, eventData.event.tid.toString(), novalnetHelper.getCurrentDate());
            if (['INSTALMENT_INVOICE', 'GUARANTEED_INVOICE'].indexOf(paymentType) > -1) {
				if(empty(eventData.transaction.bank_details)) {
					var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
					eventData.transaction.bank_details = paymentResponse.transaction.bank_details;
				}
                comment += '\n' + novalnetHelper.getPaymentComments(eventData);
            }
        } else if (['PENDING', 'ON_HOLD'].indexOf(order.custom.novalnetPaymentStatus) > -1) {
            if (['INSTALMENT_DIRECT_DEBIT_SEPA', 'INSTALMENT_INVOICE'].indexOf(paymentType) > -1 && status === 'CONFIRMED') {
                novalnetHelper.updateInstalmentDetails(order, eventData);
            }

            if (['INVOICE', 'INSTALMENT_INVOICE', 'GUARANTEED_INVOICE', 'PREPAYMENT'].indexOf(paymentType) > -1) {
                var transactionComment = novalnetHelper.formComments(eventData, order, true);
                novalnetHelper.addOrderNote(order, transactionComment, false);
            }

            comment = '\n' + Resource.msgf('novalnet.webhook.transaction.updated', 'novalnet', null, eventData.event.tid.toString(), formattedAmount, novalnetHelper.getCurrentDate());
            if (eventData.transaction.due_date) {
                var lang = (paymentType === 'CASHPAYMENT') ? 'novalnet.webhook.transaction.updatedwithslipdate' : 'novalnet.webhook.transaction.updatedwithduedate';
                comment = '\n' + Resource.msgf(lang, 'novalnet', null, formattedAmount, eventData.transaction.due_date);
            }
        }
        
        if(eventData.transaction.amount && (!empty(eventData.transaction.update_type) && ['AMOUNT', 'AMOUNT_DUE_DATE'].indexOf(eventData.transaction.update_type) > -1)) {
			    Transaction.begin();
				Transaction.wrap(function () {
					if (status) {
						order.custom.novalnetOrderAmount = eventData.transaction.amount;
					}
				});
				Transaction.commit();
		}

        if (comment) {
            updateTransactionDetails(order, comment, status);
            novalnetHelper.updateOrderStatus(order, status, paymentType);
            sendWebHookMail(res, next, eventData.transaction.order_no, comment);
            displayMessage(res, next, comment);
        }
    }
}

/**
 * Handle transaction refund
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handleTransactionRefund(order, eventData, res, next) {
    if (eventData.transaction.refund.amount) {
        var formattedAmount = novalnetHelper.getFormattedAmount(eventData.transaction.refund.amount, eventData.transaction.refund.currency);
        var comment = '\n' + Resource.msgf('novalnet.webhook.transaction.refunded', 'novalnet', null, eventData.event.parent_tid.toString(), formattedAmount);

        if (eventData.transaction.refund.tid) {
            comment += Resource.msgf('novalnet.webhook.transaction.refundedtid', 'novalnet', null, eventData.transaction.refund.tid.toString(), formattedAmount);
        }
        
        Transaction.begin();
		Transaction.wrap(function () {
			order.custom.novalnetRefundedAmount += eventData.transaction.refund.amount;
			if (!(['INSTALMENT_DIRECT_DEBIT_SEPA', 'INSTALMENT_INVOICE'].indexOf(eventData.transaction.payment_type) > -1) && ['DEACTIVATED', 'FAILURE'].indexOf(eventData.transaction.status) > -1) {
				order.setStatus(order.ORDER_STATUS_CANCELLED);
				order.custom.novalnetPaymentStatus = eventData.transaction.status;
			}
			if(['INSTALMENT_DIRECT_DEBIT_SEPA', 'INSTALMENT_INVOICE'].indexOf(eventData.transaction.payment_type) > -1) {
				var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
				if(paymentResponse.instalment) {
					var instalmentDetails = paymentResponse.instalment;
					for (var cycle in instalmentDetails) {
						if(instalmentDetails[cycle].tid == eventData.event.parent_tid) {
							var refundedAmount = instalmentDetails[cycle].refunded_amount ? (instalmentDetails[cycle].refunded_amount + eventData.transaction.refund.amount): eventData.transaction.refund.amount;
							instalmentDetails[cycle].refunded_amount = refundedAmount;
							paymentResponse.instalment = instalmentDetails;
							order.custom.novalnetServerResponse = JSON.stringify(paymentResponse);
						}
					}
				}
			}
		});
		Transaction.commit();
		
        updateTransactionDetails(order, comment);
        sendWebHookMail(res, next, eventData.transaction.order_no, comment);
        displayMessage(res, next, comment);
    }
}

/**
 * Update novalnet payment status and add order comments
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {string} comment - payment comment
 * @param {string} status - novalnet transaction status
 * @returns {void}
 */
function updateTransactionDetails(order, comment, status) {
    novalnetHelper.addOrderNote(order, comment, true);
    Transaction.begin();
    Transaction.wrap(function () {
        if (status) {
            order.custom.novalnetPaymentStatus = status;
        }
    });
    Transaction.commit();
}

/**
 * Handle transaction capture/cancel
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handleTransactionCaptureCancel(order, eventData, res, next) {
    var comment = '';
    if (eventData.event.type === 'TRANSACTION_CAPTURE') {
        comment = Resource.msgf('novalnet.webhook.transaction.confirmed', 'novalnet', null, novalnetHelper.getCurrentDate());
        if (['INSTALMENT_INVOICE', 'INSTALMENT_DIRECT_DEBIT_SEPA'].indexOf(eventData.transaction.payment_type) > -1) {
			novalnetHelper.updateInstalmentDetails(order, eventData);
		}
        if (['INVOICE', 'GUARANTEED_INVOICE', 'INSTALMENT_INVOICE', 'PREPAYMENT'].indexOf(eventData.transaction.payment_type) > -1) {			
			var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
			
			if(empty(eventData.transaction.bank_details)) {
				eventData.transaction.bank_details = paymentResponse.transaction.bank_details;
			}
			
            var transactionComment = novalnetHelper.formComments(eventData, order, true);
            novalnetHelper.addOrderNote(order, transactionComment, false);
        }
    } else if (eventData.event.type === 'TRANSACTION_CANCEL') {
        comment = Resource.msgf('novalnet.webhook.transaction.cancelled', 'novalnet', null, novalnetHelper.getCurrentDate());
    }

    if (comment) {
        updateTransactionDetails(order, comment, eventData.transaction.status);
        novalnetHelper.updateOrderStatus(order, eventData.transaction.status, eventData.transaction.payment_type);
        sendWebHookMail(res, next, eventData.transaction.order_no, comment);
        displayMessage(res, next, comment);
    }
}

/**
 * Handles communication failure
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @returns {void}
 */
function handleCommunicationFailure(order, eventData) {
    var status = eventData.result.status ? eventData.result.status : '';
    try {
        if (status === 'FAILURE' || ['FAILURE', 'DEACTIVATED'].indexOf(eventData.transaction.status) > -1) {
            
            Transaction.begin();
			Transaction.wrap(function () {
				OrderMgr.failOrder(order, true);
			});
			Transaction.commit();
			
            novalnetHelper.handleFailure(order, eventData);
        }
        else {
			novalnetHelper.handleSuccess(order, eventData);
			// custom fraudDetection
			const fraudDetectionStatus = { status: 'success' };

			// Places the order
			var placeOrderResult = COHelpers.placeOrder(order, fraudDetectionStatus);
			if (placeOrderResult.error) {
				Transaction.begin();
				Transaction.wrap(function () {
					OrderMgr.failOrder(order, true);
				});
				Transaction.commit();
				return "An Error ocuured";
			}
		}
		novalnetHelper.updateOrderStatus(order, eventData.transaction.status, eventData.transaction.payment_type);
    } catch (e) {
        return e.message;
    }
}

/**
 * Handles payment remainder
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handlePaymentReminder(order, eventData, res, next) {
	var noOfRemainder = eventData.event.type.replace(/[^0-9]/g, '');
	var comment = '\n' + Resource.msgf('novalnet.webhook.payment_remainder', 'novalnet', null, noOfRemainder.toString());
	updateTransactionDetails(order, comment);
	sendWebHookMail(res, next, eventData.transaction.order_no, comment);
	displayMessage(res, next, comment);
}

/**
 * Handles collection
 * @param {dw.order.Order} order - the order to handle payments for.
 * @param {Object} eventData - the event data from novalnet.
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @returns {void}
 */
function handleCollection(order, eventData, res, next) {
	var collectionReference = '';
	if(!empty(eventData.collection.reference)) {
		collectionReference = eventData.collection.reference.toString();
	}
	var comment = '\n' + Resource.msgf('novalnet.webhook.collection', 'novalnet', null, collectionReference);
	updateTransactionDetails(order, comment);
	sendWebHookMail(res, next, eventData.transaction.order_no, comment);
	displayMessage(res, next, comment);
}

/**
 * Display the message
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @param {Function} message - message to be displayed
 * @returns {void}
 */
function displayMessage(res, next, message) {
    var template = 'novalnetWebhook';
    res.render(template, { response: { message: message } });
    next();
}

/**
 * Authenticate server request
 * @param {string} data - data received from novalnet.
 * @returns {void}
 */
function authenticateEventData(data) {
    var testMode = novalnetConfig.getWebhookTestMode();

    if (request.getHttpRemoteAddress()) {
        if (!(['213.95.190.5'].indexOf(request.getHttpRemoteAddress()) > -1) && testMode === false) {
            return 'Unauthorised access from the IP ' + request.getHttpRemoteAddress();
        }
    } else {
        return 'Unauthorised access from the IP. Host/recieved IP is empty';
    }

    return validateEventData(data);
}

/**
 * validate the event data
 * @param {eventData} eventData - data received from novalnet.
 * @returns {void}
 */
function validateEventData(eventData) {
    try {
        eventData = JSON.parse(eventData);
    } catch (e) {
        return 'Received data is not in the JSON format ' + e.message;
    }

    var mandatory = {
        event: ['type', 'checksum', 'tid'],
        merchant: ['vendor', 'project'],
        result: ['status'],
        transaction: ['tid', 'payment_type', 'status']
    };

    for (var category in mandatory) { // eslint-disable-line guard-for-in
        if (!eventData[category]) {
            return 'Required parameter category(' + category + ') not received';
        }

        for (var i = 0; i < mandatory[category].length; i++) {
            var parameter = mandatory[category][i];
            if (!parameter) {
                return 'Required parameter(' + parameter + ') in the category(' + category + ') not received';
            } else if (['tid', 'parent_tid'].indexOf(parameter) > -1 && !(/^\d{17}$/.test(eventData[category][parameter]))) {
                return 'Invalid TID received in the category(' + category + ') not received ' + parameter;
            }
        }
    }
}

/**
 * validate the checksum
 * @param {eventData} eventData - data received from novalnet.
 * @returns {void}
 */
function validateChecksum(eventData) {
    var tokenString = eventData.event.tid + eventData.event.type + eventData.result.status;

    if (!empty(eventData.transaction.amount)) {
        tokenString += eventData.transaction.amount;
    }
    if (eventData.transaction.currency) {
        tokenString += eventData.transaction.currency;
    }

    var paymentAccessKey = novalnetConfig.getPaymentAccessKey();
    if (paymentAccessKey) {
        tokenString += paymentAccessKey.split('').reverse().join('');
    }

    var hash = crypto.MessageDigest('SHA-256');
    var genChecksum = hash.digest(tokenString);
    if (genChecksum != eventData.event.checksum) {
        return 'While notifying some data has been changed. The hash check failed';
    }
    
    if(!empty(eventData.custom)) {
		if(!empty(eventData.custom.shop_invoked)) {
			return "Process already handled in the shop";
		}
	}
}

/**
 * Send webhook notification mail
 * @param {Object} res - Response object
 * @param {Function} next - Next call in the middleware chain
 * @param {string} orderNo - order number.
 * @param {string} comment - mail content.
 * @returns {void}
 */
function sendWebHookMail(res, next, orderNo, comment) {
    var emailTo = novalnetConfig.getWebhookEmail();
    if (emailTo) {
        var mail = new dw.net.Mail(); // eslint-disable-line no-undef
        var site = require('dw/system/Site');
        var emailFrom = site.current.getCustomPreferenceValue('customerServiceEmail') || 'no-reply@testorganization.com';
        var subject = 'Novalnet Callback script notification - Order No : ' + orderNo;
        comment = comment.replace(/\n/g, '<br />');
        try {
            mail.addTo(emailTo);
            mail.setFrom(emailFrom);
            mail.setSubject(subject);
            mail.setContent(comment, 'text/html', 'UTF-8');
            mail.send();
        } catch (e) {
            displayMessage(res, next, e.message);
        }
    }
}

module.exports = server.exports();
