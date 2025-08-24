from typing import Optional
from pydantic import BaseModel

class Endpoint(BaseModel):
    """
    The `Endpoint` class encapsulates information pertaining to nodes extracted from a YANG model.

    Attributes:
        node_path (str): The node path within the generated OpenAPI Specification.
        keys (Optional[List[str]]): A list of keys associated with this node.
        endpoint_name (Optional[str]): An alternative name for the node.
        privileges (Optional[List[str]]): A list of privileges, such as 
        create, update, delete, used to reconfigure the node.
    """
    node_path: str
    keys: Optional[list[str]] = None
    endpoint_name: Optional[str] = None
    privileges: Optional[list[str]] = None
