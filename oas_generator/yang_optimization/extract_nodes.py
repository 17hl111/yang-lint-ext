import os
from endpoint import Endpoint
from yangson import DataModel

endpoints = []
module_keys = {}

target_prefixes = ["ep", "pr"]

def inject_keys(original_path, partial_path, keys):
    # Format each key by appending the partial_path to it and enclosing in curly braces
    formatted_keys = [f"{{{partial_path}-{key}}}" for key in keys]
    
    # Join the formatted keys with a comma without spaces
    formatted_string = "},{".join(keys)
    
    # Create the final replacement string by enclosing the formatted keys in curly braces
    replacement_string = f"{partial_path}={{{formatted_string}}}"
    
    # Replace the partial_path in the original_path with the replacement_string
    return original_path.replace(partial_path, replacement_string, 1)


def update_paths():
    current_endpoint = {}
    for index, endpoint in enumerate(endpoints):
        current_endpoint[endpoint.node_path] = []
        for key, value in module_keys.items():
           # try:
            if  key in endpoint.node_path:
                new_path = inject_keys(endpoint.node_path, key, value)
                current_endpoint[endpoint.node_path].append(new_path)
                #index = find_index_by_node_path(endpoint.node_path)
                # if endpoint.node_path == 'tinaa-l3vpn-ntw:l3vpn-ntw/vpn-services/vpn-service/vpn-nodes/vpn-node' \
                #     and key.startswith('tinaa-l3vpn-ntw:l3vpn-ntw/vpn-services/'):
                #     print(f"key, value: {key} - {value}")
                #     print(f"node_path: {new_path}")
                #     print(f"current node_path: {endpoint.node_path}")
                #     print("-----------------------------")
                merged_path = endpoint.node_path
                for path in current_endpoint[endpoint.node_path]:  
                    merged_path = merge_missing_parts(merged_path, path)
                endpoints[index] = endpoints[index].copy(update={"node_path": merged_path})
                # except Exception as e:
                #     print(f"Error while updating path {endpoint.node_path}: {str(e)}")


def merge_missing_parts(str1, str2):
    # Split the strings into components
    components1 = str1.split('/')
    components2 = str2.split('/')
    
    # Initialize a list to hold the merged components
    merged_components = []
    
    # Iterate through the components of both strings
    for comp1, comp2 in zip(components1, components2):
        # If the components are equal, add either to the merged list
        if comp1 == comp2:
            merged_components.append(comp1)
        else:
            # Split the components further based on '='
            parts1 = comp1.split('=')
            parts2 = comp2.split('=')
            
            # Initialize merged component
            merged_comp = ""
            
            # Merge based on the presence of '=' and '{}'
            if len(parts1) > 1 and len(parts2) > 1:  # Both have '='
                merged_comp = parts1[0] + "={" + parts1[1].strip('{}') + "}/" + parts2[0] + "={" + parts2[1].strip('{}') + "}"
            elif len(parts1) > 1:  # Only first component has '='
                merged_comp = parts1[0] + "={" + parts1[1].strip('{}') + "}"
            elif len(parts2) > 1:  # Only second component has '='
                merged_comp = parts2[0] + "={" + parts2[1].strip('{}') + "}"
            else:  # No '=' in both, use the first component (this should ideally not happen if inputs are consistent)
                merged_comp = comp1
            
            # Add the merged component to the list
            merged_components.append(merged_comp)
    
    # Reconstruct the merged string
    merged_string = '/'.join(merged_components)
    
    return merged_string

    
def find_index_by_node_path(node_path_to_find: str, endpoints) -> int:
    for index, instance in enumerate(endpoints):
        if instance.node_path == node_path_to_find:
            # if node_path_to_find == 'tinaa-l3vpn-ntw:vpn-instance-profile/address-family':
            #     print(index)
            #     print(f"found: {instance.node_path}")
            return index
    raise ValueError(f"No instance found with node_path: {node_path_to_find}")

def update_instance_by_node_path(node_path_to_find: str, new_data: dict, endpoints: list[Endpoint]):
    index = find_index_by_node_path(node_path_to_find, endpoints)
    endpoints[index] = endpoints[index].copy(update=new_data)


def display_all_instances(instances_list: list[Endpoint]):
    for instance in instances_list:
        print(instance)
        
def split_and_get_last_part(s: str) -> str:
    # Split the string by ':' first.
    parts_by_colon = s.split(':', -1)

    # If there was a ':' in the string, work with the part after the last ':'.
    # Otherwise, work with the original string.
    string_to_split = parts_by_colon[-1] if len(parts_by_colon) > 1 else s

    # Now, split the resulting string by '/' and return the last part.
    parts_by_slash = string_to_split.split('/', -1)
    return parts_by_slash[-1]

def traverse_yang_module(node, current_path="", indent=""):
    if node.keyword in ["module", "grouping", "container", "list", "leaf", "leaf-list", "choice"]:
        separator = '/'
        if ':' not in current_path and '/' not in current_path:
            separator = ':'

        path = f"{current_path}{separator}{node.argument}" if current_path else node.argument
        endpoints.append(
            Endpoint(node_path=path)
        )
    else:
        path = current_path

    if node.keyword == 'key':
        keys = [f"{split_and_get_last_part(path)}-{key}" for key in node.argument.split()]
        module_keys[path] = keys
        update_instance_by_node_path(
            node_path_to_find=path,
            new_data={"keys": keys},
            endpoints=endpoints
        )

    if node.prefix in target_prefixes:
        if node.keyword == 'endpoint':
            update_instance_by_node_path(
                node_path_to_find=path,
                new_data={"endpoint_name": node.argument},
                endpoints=endpoints
            )
        if node.keyword == 'privileges':
            update_instance_by_node_path(
                node_path_to_find=path,
                new_data={"privileges": node.argument.split()},
                endpoints=endpoints
            )

    for subnode in node.substatements:
        traverse_yang_module(subnode, path, indent + "  ")

def get_endpoints(module_name) -> list[Endpoint]:
    dm = DataModel.from_file("temp/yang-library.json", [".", "temp"])
    module_name = os.path.splitext(module_name)[0]
    module = dm.schema_data.modules[(module_name, '')].statement

    for node in module.substatements:
        traverse_yang_module(node, module.argument)

    update_paths()

    filtered_data = [endpoint for endpoint in endpoints if endpoint.endpoint_name is not None]
    return filtered_data
