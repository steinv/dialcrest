/**
 * jest.mock('googleapis') factory + accessors for the androidpublisher calls
 * refreshGoogleSubscription makes. Import and call `installGoogleMock()` once
 * per test file (after `jest.mock('googleapis')`), then use the returned
 * jest.fn()s to script responses and assert calls.
 */
export function installGoogleMock() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const googleapis = require('googleapis');
    return googleapis.__mockGoogle as {
        subscriptionsV2Get: jest.Mock;
        acknowledge: jest.Mock;
    };
}

export function mockGoogleapisModule() {
    const subscriptionsV2Get = jest.fn();
    const acknowledge = jest.fn().mockResolvedValue({});
    return {
        google: {
            auth: { GoogleAuth: jest.fn().mockImplementation(() => ({})) },
            androidpublisher: jest.fn().mockReturnValue({
                purchases: {
                    subscriptionsv2: { get: subscriptionsV2Get },
                    subscriptions: { acknowledge },
                },
            }),
        },
        __mockGoogle: { subscriptionsV2Get, acknowledge },
    };
}

/** Shape of a `purchases.subscriptionsv2.get` response, trimmed to the fields refreshGoogleSubscription reads. */
export function googleSubscriptionV2Response(opts: {
    expiryTime: string;
    autoRenewEnabled: boolean;
    basePlanId: string;
    productId?: string;
    acknowledgementState?: 'ACKNOWLEDGEMENT_STATE_PENDING' | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    linkedPurchaseToken?: string;
}) {
    return {
        data: {
            lineItems: [
                {
                    expiryTime: opts.expiryTime,
                    autoRenewingPlan: { autoRenewEnabled: opts.autoRenewEnabled },
                    offerDetails: { basePlanId: opts.basePlanId },
                    productId: opts.productId ?? 'dialcrest',
                },
            ],
            acknowledgementState: opts.acknowledgementState ?? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
            linkedPurchaseToken: opts.linkedPurchaseToken,
        },
    };
}
