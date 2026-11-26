# AWS S3 + CloudFront Deployment (Frontend)

This project is a React + Vite single-page application. The GitHub Actions workflow
`.github/workflows/frontend-cicd.yml` validates every push and pull request to `main`.
A push to `main` deploys the already-built `dist/` artifact to a private S3 bucket and
invalidates the CloudFront entry-point cache.

## 1. Required AWS architecture

- An S3 bucket used only for the frontend build output.
- The bucket remains **private**; do not enable S3 static website public access.
- A CloudFront distribution with the S3 bucket as its origin.
- Origin Access Control (OAC) configured for the S3 origin.
- The CloudFront distribution's default root object set to `index.html`.
- A GitHub Actions IAM role trusted through GitHub's OIDC provider.

The workflow does not create AWS resources. Create and configure these resources once
before enabling production deployment.

## 2. SPA route fallback

This app uses client-side routes. Configure the CloudFront distribution's custom error
responses so direct navigation and refreshes on routes such as `/customer/dashboard`
return the SPA entry point:

| HTTP error from S3 | Response page | Viewer response code | Error caching minimum TTL |
|---|---|---:|---:|
| 403 | `/index.html` | 200 | 0 |
| 404 | `/index.html` | 200 | 0 |

This is especially important with a private S3 REST origin/OAC, where a missing object
can be returned as 403. Do not make the S3 bucket public to solve SPA routing.

## 3. GitHub configuration

Create a GitHub Environment named `production` under the repository's
**Settings → Environments**.

Add these environment variables:

| Variable | Example / meaning |
|---|---|
| `AWS_REGION` | `ap-southeast-1` (use the region where the bucket is created) |
| `S3_BUCKET` | Exact S3 bucket name |
| `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront distribution ID |

Add this environment secret:

| Secret | Meaning |
|---|---|
| `AWS_ROLE_ARN` | ARN of the IAM role assumed by GitHub Actions using OIDC |

Add these repository variables under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Meaning |
|---|---|
| `VITE_API_BASE_URL` | Production backend origin only, e.g. `https://your-api.example.com`; do not append `/api/v1` because the Axios client appends it |
| `ENABLE_AWS_DEPLOY` | Keep unset or set to `false` until AWS is ready; set to the exact value `true` to enable automatic deployment after successful builds on `main` |

`VITE_API_BASE_URL` is embedded in the browser bundle and is **not a secret**. Never put credentials,
private keys, database URLs, or tokens in any `VITE_*` variable.

## 4. GitHub OIDC IAM role

Configure the AWS IAM GitHub OIDC identity provider if it does not already exist:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

Create an IAM role for the frontend repository. The repository remote in the supplied
project archive is `ranastudent/banking-platfrom-frontened`. If the repository is renamed,
update the trust policy to match the actual owner/repository.

Example role trust policy for the `production` GitHub Environment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:ranastudent/banking-platfrom-frontened:environment:production"
        }
      }
    }
  ]
}
```

Replace `<AWS_ACCOUNT_ID>` with your AWS account ID. Do not use a wildcard subject if a
repository/environment-specific subject can be used.

Attach a least-privilege permissions policy to this role. Replace bucket and distribution
placeholders with your actual resource names/ARNs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListFrontendBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<S3_BUCKET>"
    },
    {
      "Sid": "ManageFrontendBuildObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<S3_BUCKET>/*"
    },
    {
      "Sid": "InvalidateFrontendDistribution",
      "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation"],
      "Resource": "arn:aws:cloudfront::<AWS_ACCOUNT_ID>:distribution/<DISTRIBUTION_ID>"
    }
  ]
}
```

The S3 bucket policy must separately allow the CloudFront service principal to read objects
through the distribution's OAC. The GitHub deployment role does not need public-read access.

## 5. Deployment behavior

- Pull request: install, typecheck, build, and upload a short-lived build artifact; no AWS deployment.
- Push to `main`: run the same validation/build. Deployment runs only when repository variable `ENABLE_AWS_DEPLOY` is exactly `true`; otherwise it is skipped safely.
- Hashed files under `assets/` receive a one-year immutable cache policy.
- `index.html` is uploaded with no-cache/no-store headers.
- CloudFront invalidates `/` and `/index.html`.
- AWS credentials are obtained with OIDC; no long-lived AWS access key is stored in GitHub.

## 6. First deployment checklist

1. Create the private S3 bucket and CloudFront distribution with OAC.
2. Set CloudFront default root object to `index.html`.
3. Add the SPA 403/404 custom error responses above.
4. Configure the OIDC provider, IAM role trust policy, and least-privilege role policy.
5. Add the GitHub `production` environment variables and `AWS_ROLE_ARN` secret.
6. Add the repository variable `VITE_API_BASE_URL`.
7. Push the workflow while `ENABLE_AWS_DEPLOY` is unset/false; CI runs and the deployment job is skipped.
8. After AWS resources and GitHub settings are verified, set repository variable `ENABLE_AWS_DEPLOY` to `true`.
9. Push to `main` and confirm both build and deployment jobs succeed.
10. Open the CloudFront domain and test `/`, `/login`, `/register`, and a protected route refresh.

## 7. Important notes

- This workflow assumes the default Vite output directory is `dist/`.
- The API origin must allow the CloudFront frontend origin in its CORS configuration.
- Keep `.env` files local. Only `.env.example` belongs in source control.
- Build-time `VITE_*` values are public to anyone who can inspect the frontend bundle.
- The workflow does not run unit tests or lint because the current `package.json` does not
  define test or lint scripts. Add those checks when the project has configured tooling.
