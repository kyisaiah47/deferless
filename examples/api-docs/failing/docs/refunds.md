# refunds

Refunds are issued asynchronously and settle within two business days.

Requests are handled by the billing-core service, which retries failed settlements
up to three times before surfacing an error.
