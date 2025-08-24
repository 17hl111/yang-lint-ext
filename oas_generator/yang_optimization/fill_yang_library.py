import os
import subprocess
import json

def update_yang_library():
    # Directory containing the YANG files
    yang_directory = 'temp'

    # Prepare the JSON structure
    yang_library = {
        "ietf-yang-library:modules-state": {
            "module-set-id": "db63c52c6639c5596356bacee142380928ca3ac1",
            "module": []
        }
    }

    # Open the file in write mode to clear existing content and then close it immediately
    if os.path.exists(f"{yang_directory}/yang-library.json"):
        with open(f"{yang_directory}/yang-library.json", 'w') as f:
            json.dump(yang_library, f)

    # Iterate over each file in the directory
    for filename in os.listdir(yang_directory):
        if filename.endswith(".yang"):
            file_path = os.path.join(yang_directory, filename)
            # Run the pyang command
            try:
                result = subprocess.check_output(
                    ["pyang", "-f", "name", "--name-print-revision", "-p", yang_directory, file_path]#,
                    # stderr=subprocess.DEVNULL,
                    # env=env
                ).decode('utf-8').strip()
            except Exception as e:
                # Print the exception message
                print("Failed to process file:", file_path, "Error:", e)
                continue
            # Split output to get module name and revision
            if '@' in result:
                module_name, module_revision = result.split('@')
            else:
                module_name, module_revision = result, ""

            # Append module info to the JSON structure
            yang_library["ietf-yang-library:modules-state"]["module"].append({
                "name": module_name,
                "revision": "", #module_revision,
                "namespace": "", #f"urn:ietf:params:xml:ns:yang:{module_name}",
                "conformance-type": "implement"
            })

    # Write the JSON data to a file
    with open(f"{yang_directory}/yang-library.json", 'w') as f:
        json.dump(yang_library, f, indent=2)

    #print("YANG library JSON file has been created successfully.")

if __name__ == "__main__":
    update_yang_library()