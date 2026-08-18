"""Generic MongoDB-backed CRUD router factory, reused for the four
Test Manager entities (requirements, test specs, test runs, results)."""
from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException
from pymongo.collection import Collection


def serialize_doc(doc: dict) -> dict:
    doc = dict(doc)
    if "_id" in doc:
        doc["_id"] = str(doc["_id"])
    return doc


def make_crud_router(collection: Collection, prefix: str, tag: str) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[tag])

    @router.get("")
    def list_items():
        return [serialize_doc(d) for d in collection.find()]

    @router.post("")
    def create_item(item: dict):
        result = collection.insert_one(dict(item))
        created = collection.find_one({"_id": result.inserted_id})
        return serialize_doc(created)

    @router.get("/{item_id}")
    def get_item(item_id: str):
        try:
            oid = ObjectId(item_id)
        except InvalidId:
            raise HTTPException(status_code=400, detail="Invalid id")
        doc = collection.find_one({"_id": oid})
        if doc is None:
            raise HTTPException(status_code=404, detail="Not found")
        return serialize_doc(doc)

    @router.put("/{item_id}")
    def update_item(item_id: str, item: dict):
        try:
            oid = ObjectId(item_id)
        except InvalidId:
            raise HTTPException(status_code=400, detail="Invalid id")
        update_fields = {k: v for k, v in item.items() if k != "_id"}
        result = collection.update_one({"_id": oid}, {"$set": update_fields})
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Not found")
        return serialize_doc(collection.find_one({"_id": oid}))

    @router.delete("/{item_id}")
    def delete_item(item_id: str):
        try:
            oid = ObjectId(item_id)
        except InvalidId:
            raise HTTPException(status_code=400, detail="Invalid id")
        result = collection.delete_one({"_id": oid})
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Not found")
        return {"status": "deleted"}

    return router
