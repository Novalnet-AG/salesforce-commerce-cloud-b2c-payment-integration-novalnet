/* global dw request response empty */
/* eslint-disable no-shadow */

'use strict';

var ISML = require('dw/template/ISML');
var OrderMgr = require('dw/order/OrderMgr');
var ArrayList = require('dw/util/ArrayList');
var CSRFProtection = require('dw/web/CSRFProtection');
var Transaction = require('dw/system/Transaction');
var Resource = require('dw/web/Resource');
var novalnetHelper = require('*/cartridge/scripts/novalnetHelper');
var novalnetService = require('*/cartridge/scripts/novalnetService');
var novalnetConfig = require('*/cartridge/scripts/novalnetConfig');

/**
 * Combine order and Novalnet Transactions Custom Objects into one array for pagination
 *
 * @param {string} orderNo - Order number used in "Search by order number" feature
 * @returns {dw.util.ArrayList} Combined array with all order
 */
function getOrders(orderNo) {
    var obj;
    var orders = new ArrayList();
    var orderDate;
    var systemOrders;
    if (orderNo) { // searching for an order ID
        systemOrders = OrderMgr.searchOrder('orderNo = {0}', orderNo);
        if (systemOrders) {
            orderDate = new Date(systemOrders.creationDate);
            obj = {
                orderNo: systemOrders.orderNo,
                orderToken: systemOrders.orderToken,
                orderDate: dw.util.StringUtils.formatCalendar(new dw.util.Calendar(orderDate), 'M/dd/yy h:mm a'),
                createdBy: systemOrders.createdBy,
                customer: systemOrders.customerName,
                email: systemOrders.customerEmail,
                orderTotal: systemOrders.totalGrossPrice,
                currencyCode: systemOrders.getCurrencyCode(),
                status: systemOrders.status.displayValue,
                dateCompare: orderDate.getTime(),
                novalnetPayment: Resource.msg('novalnet.' + (systemOrders.custom.novalnetPaymentMethod).toLowerCase() + '.name', 'novalnet', null)
            };
            orders.push(obj);
        }
    } else { // all orders on pagination
        systemOrders = OrderMgr.queryOrders('custom.novalnetPaymentMethod != {0}', 'creationDate desc', null);
        var order;
        while (systemOrders.hasNext()) {
            order = systemOrders.next();
            orderDate = new Date(order.creationDate);
            obj = {
                orderNo: order.orderNo,
                orderToken: order.orderToken,
                orderDate: dw.util.StringUtils.formatCalendar(new dw.util.Calendar(orderDate), 'M/dd/yy h:mm a'),
                createdBy: order.createdBy,
                customer: order.customerName,
                email: order.customerEmail,
                orderTotal: order.totalGrossPrice,
                currencyCode: order.getCurrencyCode(),
                status: order.status.displayValue,
                dateCompare: orderDate.getTime(),
                novalnetPayment: Resource.msg('novalnet.' + (order.custom.novalnetPaymentMethod).toLowerCase() + '.name', 'novalnet', null)
            };
            orders.push(obj);
        }
    }
    orders.sort(new dw.util.PropertyComparator('dateCompare', false));

    return orders;
}

/**
 * Render Template
 * @param {string} templateName - Template Name
 * @param {Object} data - pdict data
 */
function render(templateName, data) {
    if (typeof data !== 'object') {
        data = {}; // eslint-disable-line no-param-reassign
    }
    try {
        ISML.renderTemplate(templateName, data);
    } catch (e) {
        throw new Error(e.javaMessage + '\n\r' + e.stack, e.fileName, e.lineNumber);
    }
}


/**
 * Get orders list. Can be filtered by order ID
 */
function orders() {
    var orderNo = request.httpParameterMap.orderNo.value || '';
    var orders = getOrders(orderNo);

    var pageSize = !empty(request.httpParameterMap.pagesize.intValue) ? request.httpParameterMap.pagesize.intValue : 10;
    var currentPage = request.httpParameterMap.page.intValue ? request.httpParameterMap.page.intValue : 1;
    pageSize = pageSize === 0 ? orders.length : pageSize;
    var start = pageSize * (currentPage - 1);
    var orderPagingModel = new dw.web.PagingModel(orders);

    orderPagingModel.setPageSize(pageSize);
    orderPagingModel.setStart(start);
    render('novalnetbm/orderList', {
        PagingModel: orderPagingModel
    });
}

/**
 * Get order transaction details
 */
function orderTransaction() {
    var order = null;

    if (!empty(request.httpParameterMap.orderToken.value) && !empty(request.httpParameterMap.orderNo.value)) {
        order = dw.order.OrderMgr.getOrder(request.httpParameterMap.orderNo.stringValue, request.httpParameterMap.orderToken.stringValue);

        if (empty(order)) {
            ISML.renderTemplate('novalnetbm/components/serverError');
            return;
        }
    } else {
        ISML.renderTemplate('novalnetbm/components/serverError');
        return;
    }

    var novalnetPaymentStatus = order.custom.novalnetPaymentStatus;
    var novalnetPaymentMethod = order.custom.novalnetPaymentMethod;
    var refundedAmount = order.custom.novalnetRefundedAmount;
    var novalnetAmount = order.custom.novalnetOrderAmount;
    novalnetAmount -= refundedAmount;

    var showRefund = false;
    var showManageTransaction = false;
    var showInstalmentDetails = false;
    var showZeroAmountBooking = false;
    var novalnetInstalmentData = '';
    
    if (['INSTALMENT_DIRECT_DEBIT_SEPA', 'INSTALMENT_INVOICE'].indexOf(novalnetPaymentMethod) > -1) {
        novalnetInstalmentData = novalnetHelper.getInstalmentDetails(order.custom.novalnetServerResponse);
		showInstalmentDetails = true;
    } else if (novalnetAmount > 0 && (novalnetPaymentStatus === 'CONFIRMED' || (['INVOICE', 'PREPAYMENT', 'CASHPAYMENT'].indexOf(novalnetPaymentMethod) > -1 && novalnetPaymentStatus === 'PENDING'))) {
        showRefund = true;
        if(novalnetPaymentMethod === 'MULTIBANCO') {
		  showRefund = false;	
		}
    }
    if (novalnetPaymentStatus === 'ON_HOLD') {
        showManageTransaction = true;
    }
    if(order.custom.novalnetZeroAmountBooking && order.custom.novalnetZeroAmountBooking == true && order.custom.novalnetPaidAmount == 0) {
		showZeroAmountBooking = true;
	}
	
	var paymentInstrument = novalnetHelper.getPaymentInstrument(order);
	var orderAmount = paymentInstrument ? Math.floor(paymentInstrument.paymentTransaction.amount.value * 100).toString() : 0;

    var data = {
        orderNo: order.orderNo,
        orderToken: order.orderToken,
        customer: order.customerName,
        email: order.customerEmail,
        orderTotal: order.totalGrossPrice,
        orderAmount: orderAmount,
        transactionId: order.custom.novalnetTid,
        paymentStatus: order.paymentStatus,
        confirmationStatus: order.confirmationStatus,
        exportStatus: order.exportStatus,
        shippingStatus: order.shippingStatus,
        orderStatus: order.status,
        paymentMethod: Resource.msg('novalnet.' + novalnetPaymentMethod.toLowerCase() + '.name', 'novalnet', null),
        novalnetComments: order.custom.novalnetPaymentComment,
        novalnetAmount: novalnetAmount.toString(),
        showRefund: showRefund,
        showManageTransaction: showManageTransaction,
        novalnetStatus: order.custom.novalnetPaymentStatus,
        showInstalmentDetails: showInstalmentDetails,
        showZeroAmountBooking: showZeroAmountBooking,
        novalnetInstalmentData: novalnetInstalmentData
    };

    ISML.renderTemplate('novalnetbm/novalnetTransaction', data);
}


/**
 * Do some action, like Refund, Capture, Cancel  and etc
 */
function action() {
    var params = request.httpParameterMap;
    var result = {};
    var action = params.action.stringValue;

    if (!CSRFProtection.validateRequest()) {
        result = { statusText: 'CSRF token mismatch' };
        renderJson(result);
        return;
    }
    var order = dw.order.OrderMgr.getOrder(params.orderNo.stringValue, params.orderToken.stringValue);
    if (params.tid.stringValue && order) {
        switch (action) {
            case 'refund':
                var refundResult = executeRefund(params, order);
                renderJson(refundResult);
                break;
            case 'capture':
            case 'cancel':
                result = executeVoidCapture(params, order);
                renderJson(result);
                break;
            case 'instalment_cancel':
				result = executeInstalmentCancel(params, order);
				renderJson(result);
				break;
            case 'zero_amount_booking':
                result = executeAmountBooking(params, order);
                renderJson(result);
                break;
            default:
                renderJson({ statusText: 'invalid action' });
                break;
        }
    }
}

function executeAmountBooking(params, order) {
	var paymentInstrument = novalnetHelper.getPaymentInstrument(order);
	
	var data = {};
    data.merchant = novalnetHelper.getMerchantDetails();
    data.customer = novalnetHelper.getCustomerDetails(order, paymentInstrument);
    data.transaction = novalnetHelper.getTransactionDetails(order, paymentInstrument);
	data.custom = novalnetHelper.getCustomParam(order);
	
	data.custom.shop_invoked = 1;
	data.transaction.payment_type = order.custom.novalnetPaymentMethod;
	data.transaction.amount = params.amount.stringValue;
	data.transaction.payment_data = {
		token : order.custom.novalnetPaymentToken
	};
	
	
	var serverUrl = 'https://payport.novalnet.de/v2/payment';
	var callResult = novalnetService.getNovalnetService(serverUrl).call(JSON.stringify(data));
	
	 if (callResult.isOk() === false) {
        novalnetHelper.debugLog(callResult.getErrorMessage());
        return { statusText: callResult.getErrorMessage() };
    }
    var response = {};
    try {
        response = novalnetHelper.getFormattedResult(callResult.object);
    } catch (e) {
        return { statusText: e.message };
    }
	
	var formattedAmount = novalnetHelper.getFormattedAmount(response.transaction.amount, response.transaction.currency);
    if (response.result.status === 'SUCCESS') {
		var tid = response.transaction.tid;
		var comment = '\n' + Resource.msgf('novalnet.amount_booked', 'novalnet', null, formattedAmount, tid);
		Transaction.begin();
        Transaction.wrap(function () {
			order.custom.novalnetPaidAmount = response.transaction.amount;
			order.custom.novalnetOrderAmount = response.transaction.amount;
			order.custom.novalnetTid = tid;
			paymentInstrument.paymentTransaction.transactionID = tid;
			
		});
		Transaction.commit();
		novalnetHelper.addOrderNote(order, comment, true);
	}	
	return { statusText: response.result.status_text };	
}

/**
 * Send Instalment cancel request
 * @param {Object} params - http request object
 * @param {dw.order} order - order object
 * @returns {Object} success/ failure error message
 */
function executeInstalmentCancel(params, order) {
    var data = {
        custom: {
            lang: novalnetConfig.getCurrentLang(),
            shop_invoked: 1
        },
        instalment: {
			tid : params.tid.stringValue
		}
    };
    
    var serverUrl = 'https://payport.novalnet.de/v2/instalment/cancel';
    var cancelType = params.cancelType.stringValue;
    data.instalment.cancel_type = cancelType.toUpperCase();
    
    var callResult = novalnetService.getNovalnetService(serverUrl).call(JSON.stringify(data));

    if (callResult.isOk() === false) {
        novalnetHelper.debugLog(callResult.getErrorMessage());
        return { statusText: callResult.getErrorMessage() };
    }
    
    var response = {};
    try {
        response = novalnetHelper.getFormattedResult(callResult.object);
    } catch (e) {
        return { statusText: e.message };
    }
    
    if (response.result.status_code === 100) {
        var comment;
        var status = response.transaction.status;
        if (cancelType == 'cancel_all_cycles') {
			var currency = response.transaction.refund.currency ? response.transaction.refund.currency : 'EUR';
			var formattedRefundAmount = novalnetHelper.getFormattedAmount(response.transaction.refund.amount, currency);			
            comment = '\n' + Resource.msgf('novalnet.cancel_all_instalment_cycle.message', 'novalnet', null, params.tid.stringValue, novalnetHelper.getCurrentDate(), formattedRefundAmount);
        } else {
			comment = '\n' + Resource.msgf('novalnet.cancel_remaining_instalment_cycle.message', 'novalnet', null, params.tid.stringValue, novalnetHelper.getCurrentDate());
        }
		
		var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
		if(paymentResponse.instalment) {
			var instalmentDetails = paymentResponse.instalment;
			instalmentDetails.cancel_type = cancelType;
			paymentResponse.instalment = instalmentDetails;
			
			Transaction.begin();
			Transaction.wrap(function () {
				order.custom.novalnetServerResponse = JSON.stringify(paymentResponse);
				if (cancelType == 'cancel_all_cycles') {
					order.setStatus(order.ORDER_STATUS_CANCELLED);
				}
			});
			Transaction.commit();
		}
        novalnetHelper.addOrderNote(order, comment, true);
    }
    return { statusText: response.result.status_text };
}

/**
 * Send capture/ cancel request
 * @param {Object} params - http request object
 * @param {dw.order} order - order object
 * @returns {Object} success/ failure error message
 */
function executeVoidCapture(params, order) {
    var data = {
        custom: {
            lang: novalnetConfig.getCurrentLang(),
            shop_invoked: 1
        }
    };
    var serverUrl = '';
    var action = params.action.stringValue;
	data.transaction = { tid: params.tid.stringValue };
	serverUrl = 'https://payport.novalnet.de/v2/transaction/' + action;    

    var callResult = novalnetService.getNovalnetService(serverUrl).call(JSON.stringify(data));

    if (callResult.isOk() === false) {
        novalnetHelper.debugLog(callResult.getErrorMessage());
        return { statusText: callResult.getErrorMessage() };
    }
    var response = {};
    try {
        response = novalnetHelper.getFormattedResult(callResult.object);
    } catch (e) {
        return { statusText: e.message };
    }

    if (response.result.status_code === 100) {
        var status = response.transaction.status;
		var comment = (action === 'capture') ? 'novalnet.transaction.confirmed' : 'novalnet.transaction.cancelled';
		comment = '\n' + Resource.msgf(comment, 'novalnet', null, novalnetHelper.getCurrentDate());

        var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
        var appendComment = true;

        if (action === 'capture') {
            if (['INVOICE', 'INSTALMENT_INVOICE', 'GUARANTEED_INVOICE'].indexOf(response.transaction.payment_type) > -1) {
                if (!response.transaction.bank_details) {
                    response.transaction.bank_details = paymentResponse.transaction.bank_details;
                }
                comment += '\n' + novalnetHelper.formComments(response, order, true);
                appendComment = false;
            }
            if (response.instalment && response.transaction.status === 'CONFIRMED') {
                novalnetHelper.updateInstalmentDetails(order, response);
            }
        }

        novalnetHelper.addOrderNote(order, comment, appendComment);
        novalnetHelper.updateOrderStatus(order, status, response.transaction.payment_type);

        Transaction.begin();
        Transaction.wrap(function () {
            order.custom.novalnetPaymentStatus = status;
        });
        Transaction.commit();
    }
    return { statusText: response.result.status_text };
}

/**
 * Send refund request
 * @param {Object} params - http request object
 * @param {dw.order} order - order object
 * @returns {Object} success/ failure error message
 */
function executeRefund(params, order) {
    var data = {};
	var tid = params.tid.stringValue;
	
    data.transaction = {
        tid: tid,
        amount: params.refundAmount.stringValue,
        reason: params.refundReason.stringValue
    };
    data.custom = {
        lang: novalnetConfig.getCurrentLang(),
        shop_invoked: 1
    };


    var callResult = novalnetService.getNovalnetService('https://payport.novalnet.de/v2/transaction/refund').call(JSON.stringify(data));
    if (callResult.isOk() === false) {
        novalnetHelper.debugLog(callResult.getErrorMessage());
        return { statusText: callResult.getErrorMessage() };
    }

    var response = {};
    try {
        response = novalnetHelper.getFormattedResult(callResult.object);
    } catch (e) {
        return { statusText: e.message };
    }

    if (response.result.status_code === 100) {
        var formattedAmount = novalnetHelper.getFormattedAmount(response.transaction.refund.amount, response.transaction.currency);

        var comment = '\n' + Resource.msgf('novalnet.transaction.refunded', 'novalnet', null, response.transaction.tid, formattedAmount);
        if (response.transaction.refund.tid) {
            comment += Resource.msgf('novalnet.transaction.refundedtid', 'novalnet', null, response.transaction.refund.tid);
        }

        Transaction.begin();
        Transaction.wrap(function () {
            order.custom.novalnetRefundedAmount += response.transaction.refund.amount;
            if (!(['INSTALMENT_DIRECT_DEBIT_SEPA', 'INSTALMENT_INVOICE'].indexOf(response.transaction.payment_type) > -1) && ['DEACTIVATED', 'FAILURE'].indexOf(response.transaction.status) > -1) {
                order.setStatus(order.ORDER_STATUS_CANCELLED);
                order.custom.novalnetPaymentStatus = response.transaction.status;
            }
            if(['INSTALMENT_DIRECT_DEBIT_SEPA', 'INSTALMENT_INVOICE'].indexOf(response.transaction.payment_type) > -1) {
				var instalmentCycle = params.instalment_cycle.stringValue;
				var paymentResponse = JSON.parse(order.custom.novalnetServerResponse);
				if(paymentResponse.instalment) {
					var instalmentDetails = paymentResponse.instalment;
					if(instalmentDetails[instalmentCycle].tid) {
						var refundedAmount = instalmentDetails[instalmentCycle].refunded_amount ? (instalmentDetails[instalmentCycle].refunded_amount + response.transaction.refund.amount): response.transaction.refund.amount;
						instalmentDetails[instalmentCycle].refunded_amount = refundedAmount;
						paymentResponse.instalment = instalmentDetails;
						order.custom.novalnetServerResponse = JSON.stringify(paymentResponse);
					}
				}
			}
        });
        Transaction.commit();

        novalnetHelper.addOrderNote(order, comment, true);
    }

    return { statusText: response.result.status_text };
}

/**
 * Write json data in response object
 * @param {Object} data - data contains novalnet response
 */
function renderJson(data) {
    response.setContentType('application/json');
    var json = JSON.stringify(data);
    response.writer.print(json);
}

orders.public = true;
orderTransaction.public = true;
action.public = true;

exports.Orders = orders;
exports.OrderTransaction = orderTransaction;
exports.Action = action;
