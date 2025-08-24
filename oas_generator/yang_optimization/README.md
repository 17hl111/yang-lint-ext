# Endpoint Optimization

Endpoint Optimization focuses on optimizing FastAPI endpoints by leveraging the `yangson` library to enhance the generated OpenAPI Specification (OAS). The primary goal is to ensure the endpoints are correctly described and aligned with the target operations specified by the user.

## Key Features

**1. Basic YANG Model Extraction:** Extracts essential YANG model information and compiles it into a standardized `yang-library.json` format.

**2. Targeted Endpoint Extraction:** Identifies and extracts specific endpoints and desired operations from the provided YANG models.

**3. OAS Revision:** Revises the pre-generated OpenAPI Specification to accurately reflect the targeted endpoints and operations.


# Getting Started

## Prerequisites

- `yangson 1.5.10+`

## Usage

**1. Extract Basic YANG Model Information:**

- Copy the YANG model(s) into `utils` directory.

- Parse the YANG model using the `yangson` library.

- Generate a `yang-library.json` file containing the foundational information about the model.

Example command:
```
python fill_yang_library.py
```

**2. Extract Targeted Endpoints && Revise OpenAPI Specification:**

- The `extract_nodes.py` and `endpoint.py` identifies these endpoints and prepares them for OAS revision.

- Update the pre-generated OAS to include detailed descriptions of the targeted endpoints.

Example command:
```
python regenerate_oas.py "../path/to/oas3.json" ${MODEL_FILENAME}
```