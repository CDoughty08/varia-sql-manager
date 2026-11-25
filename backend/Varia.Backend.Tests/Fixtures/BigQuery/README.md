# BigQuery REST fixtures

Response bodies the offline fake (`BigQueryFake.cs`) replays, in the shapes Google documents for the BigQuery v2 REST API,
OAuth 2.0, Security Token Service, IAM Credentials and the instance metadata services. They were written from Google's
reference pages, not recorded: Varia contacts no real project in tests (docs/bigquery.md, Testing). The opt-in, billed
real-project group (docs/testing.md, Real BigQuery project) checks some of the answers they stand for and prints what it
saw; a fixture changes only by hand, never with a real project id, email or token. Project ids, emails and tokens are fictional.
