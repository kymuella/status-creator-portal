# Status Creator Portal

A separate Netlify site from the internal Automation Hub, on purpose.

Creators reach it through a personal link. There is no login: the token in the
URL identifies them.

    https://<this-site>.netlify.app/?t=<their token>

## Why it is a separate site

The internal hub holds invoice generation, creator billing details and API keys
for Anthropic, Postiz and Slack. None of that is deployed here. If this site
were ever fully compromised, the exposure is limited to creators' hooks and
their own posting figures, because nothing else exists on it.

That isolation is structural rather than a matter of writing careful code.

## Environment variables

Only two, set in Netlify:

    SUPABASE_URL           https://xxxx.supabase.co   (no /rest/v1)
    SUPABASE_SERVICE_KEY   the Supabase secret key

Do NOT add the Anthropic, Postiz, Slack or invoice keys here. Nothing on this
site needs them.

## Handing out links

Each creator's token lives in `creators.access_token`. To get the list:

    select name, access_token from creators where status = 'active';

Then send each creator their own link. To revoke one:

    update creators
    set access_token = encode(gen_random_bytes(24), 'hex')
    where name = 'Their Name';

Their old link stops working immediately.

## What creators can see

Their name, this week's published hooks, their own posting days and video
counts, and their own recent detected posts.

They cannot see pay, invoices, addresses, payment details, or anything about
another creator. The function reads `creator_portal_profile`, a database view
that does not contain those columns, so a coding mistake here cannot expose
them.

## The link is the credential

Anyone holding a creator's link can see that creator's page. That is an
accepted trade for having no passwords to support, and it is why nothing
pay-related is ever shown here. Do not add anything sensitive to this surface
without revisiting that decision.
