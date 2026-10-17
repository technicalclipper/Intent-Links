# The receiver's agent (Google ADK) for Cloud Run. Reasons about each step;
# holds no authority - every action it proposes is decided by the policy
# service at INTENTLINK_POLICY_URL.
#
#   gcloud run deploy intentlink-agent --source apps/agent --region <region> \
#     --set-env-vars INTENTLINK_POLICY_URL=<api url>,INTENTLINK_MODEL_RUNTIME=<model> \
#     --set-secrets GOOGLE_API_KEY=<secret>:latest

FROM python:3.14-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY intentlink_agent intentlink_agent
# Cloud Run supplies PORT.
CMD exec uvicorn intentlink_agent.service:app --host 0.0.0.0 --port "${PORT:-8080}"
