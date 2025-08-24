import json
import re
import sys
import extract_nodes as ext
# from openapi_spec_validator import validate_spec


def map_operations(operations):
    """
    Maps operations for a specified node.

    Parameters:
    - operations (bool or list): If True, returns ["get", "post", "put", "patch", "delete"].
      If False or None, returns nothing. If a list is provided, maps operations using
      the specified dictionary, with defaulting to the original value if not found.

    Returns:
    - list: Mapped list of operations.

    Examples:
    >>> map_operations(True)
    ['get', 'post', 'put', 'patch', 'delete']

    >>> map_operations(['fetch', 'create', 'update'])
    ['get', 'post', 'put']

    >>> map_operations(False)
    []
    """
    mapped_operations = []

    if operations in [[], None, False]:
        return mapped_operations
    elif operations is True:
        mapped_operations.extend(["get", "post", "put", "patch", "delete"])
    else:
        mapping = {"create": "post", "update": "put", "fetch" : "get"}
        mapped_operations.extend([mapping.get(op, op) for op in operations])

    return mapped_operations

def reformat_endpoint(endpoint: str) -> str:
    # Remove leading slash if present
    if endpoint.startswith("/"):
        endpoint = endpoint[1:]

    # Split the endpoint into segments based on '/'
    segments = endpoint.split('/')

    # Find the last segment without any path parameters
    for segment in reversed(segments):
        if '{' not in segment and '}' not in segment:  # No path parameters in this segment
            return segment

    # Return the original endpoint if no suitable segment is found (unlikely in valid endpoints)
    return endpoint

def sanitize_string(input_string):
    """
    Replaces special characters in the input string with underscores.
    
    This function removes curly braces and replaces any non-alphanumeric
    characters (except underscores) with underscores.

    Parameters:
    - input_string (str): The input string containing special characters.

    Returns:
    - str: The input string with special characters replaced by underscores.

    Example:
    >>> sanitize_string("application-name")
    'application_name'
    """
    without_parentheses = input_string.replace('{', '').replace('}', '')
    return re.sub(r'[^a-zA-Z0-9_]', '_', without_parentheses)
     
def extract_specific_methods(oas_data, target_endpoints):
    # try:
    #     validate_spec(oas_data)
    # except Exception as e:
    #     print(f"Error validating OAS file: {str(e)}")
    #     return

    filtered_data = {}
    mapping = {"post": "create", "put": "update", "get": "fetch"}

    if 'paths' in oas_data:
        for target_endpoint in target_endpoints:
            for path, endpoint_data in oas_data['paths'].items():
                if path.endswith(target_endpoint.node_path):
                    http_methods = map_operations(target_endpoint.privileges)
                    #print(http_methods)
                    filtered_methods = {method: data for method, data in endpoint_data.items() if method.lower() in http_methods}
                    #print(filtered_methods)
                    for filtered_method in filtered_methods:
                        #print(filtered_method)
                        operation_id = filtered_methods[filtered_method]['operationId']
                        sanitized_operation_id = sanitize_string(target_endpoint.node_path)
                        method = mapping.get(filtered_method, filtered_method) 
                        if operation_id.endswith(f"{sanitized_operation_id}_{method}"):
                            filtered_methods[filtered_method]['operationId'] = f"{method}_{reformat_endpoint(target_endpoint.endpoint_name)}"
                    filtered_data[target_endpoint.endpoint_name] = filtered_methods
      
        return filtered_data
    else:
        print("No 'paths' section found in the OAS file.")
        return None


def regernate_oas(oas_file_path, module_name):
    """ regenerate oas after applying annotations

    Args:
        oas_file_path (string): original oas file
    """
    target_endpoints = ext.get_endpoints(module_name)
    try:
        with open(oas_file_path, 'r') as file:
            oas_data = json.load(file)
    except Exception as e:
        raise ValueError(f"Error loading OAS file: {str(e)}")

    filtered_methods_info = extract_specific_methods(oas_data, target_endpoints)

    if filtered_methods_info:
        new_oas_data = oas_data.copy()
        new_oas_data['paths'] = filtered_methods_info
       
        new_oas_file_path = '/workdir/output/filtered-oas3.json'
        with open(new_oas_file_path, 'w') as new_file:
            json.dump(new_oas_data, new_file, indent=2)

        #print(f"Filtered OAS file saved to '{new_oas_file_path}'.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python regernate_oas.py oas_file_path module_name")
        sys.exit(1)

    arg1 = sys.argv[1]
    arg2 = sys.argv[2]
    regernate_oas(arg1, arg2)
